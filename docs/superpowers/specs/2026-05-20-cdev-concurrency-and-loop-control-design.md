# cdev concurrency & loop control — design

## Problem

The cdev autonomous subsystem exhausted the user's Claude subscription quota by spawning `claude -p` in unbounded retry loops. The symptom on 2026-05-20 ~20:42: three `pr_open` runs (20, 51, 27) whose PRs went conflicting after sibling PRs merged were hammered by both `prSweep` (60s interval) and `prReview` (120s interval). Run 51 was invoked through `prReview` **four times in 12 seconds** despite the 120-second interval.

## Root causes (four independent loop sources)

1. **No tick re-entrancy guard.** `server.js` wires `setInterval(prSweep.tick, 60s)` and `setInterval(prReview.tick, 120s)` directly. A tick that takes longer than its interval (claude calls regularly run 1–30 min) is **overlapped** by the next firing. Both ticks then iterate the same `pr_open` runs and double-spawn `claude`. This explains the 4-hits-in-12s pattern.

2. **`maxConcurrentRuns` only caps the executor pipeline.** `scheduler.js` enforces `inFlight.size < maxConcurrentRuns` for runs transitioning queued → spec_plan → implementing → reviewing → pr_open. `prSweep`, `prReview`, and `resolveConflict` have **no concurrency cap whatsoever**. The operator's mental model — "max N concurrent claude" — was never enforced for PR maintenance, where most of the recurring burn happens.

3. **prReview replays the same work on failure.** `prReview.js` `tick()` wraps `handleRun` in `try/catch` and on throw only bumps `updated_at`. The watermark (`pr_last_comment_at`), diff fingerprint (`pr_reviewed_diff_id`), and `pr_review_iterations` are not advanced. The next tick sees the same input state and redoes the same `claude` call. When `claude` exits 1 from a rate-limit, this becomes a pure retry loop.

4. **No backoff on consecutive failures.** Once `claude` starts exiting 1 (subscription quota hit), every subsequent tick still invokes it. No per-run cooldown. No global circuit breaker. The subsystem can't tell "the API is dead, stop trying."

## Goals

- **Cap concurrent `claude` invocations** globally at `MAX_CONCURRENT_RUNS` (default 2) across every code path that spawns `claude`.
- **One `claude` per issue/run at a time.** prSweep and prReview can never both invoke `claude` against the same run concurrently.
- **No overlapping ticks** for prSweep/prReview.
- **Exponential backoff per run** after consecutive failures — a stuck/failing run is parked, not re-poked every minute.
- **Global circuit breaker** — when `claude` is mostly failing (e.g. quota exhausted), the whole subsystem holds its breath instead of hammering the API.
- **Preserve all existing behavior** for healthy runs. No throughput regression on the happy path.

## Non-goals

- Replacing `setInterval` with a unified work-queue worker pool. (Considered: cleaner long-term, but a much larger refactor. Out of scope for this spec.)
- Changing the `claude -p` invocation contract or stage outputs.
- Touching the cspawn tmux pool subsystem (independent concern).
- Detecting "rate limit" vs other failures via stderr parsing. We treat any non-zero exit as a failure for backoff/circuit-breaker purposes; that is sufficient because the loops happen on any consistent failure mode.

## Design

### 1. Global `claude` semaphore (in `src/adapters/claude.js`)

Wrap `claude.run(...)` with an `acquire/release` against a shared in-process semaphore sized to `config.maxConcurrentRuns`. Every call site — executor stages, `prSweep`'s `runResolveConflict`, `prReview`'s `runPrReview`/`runPrFix` — goes through the adapter, so a single gate covers all of them.

```js
// inside createClaude
const sem = createSemaphore(maxConcurrent); // {acquire, release}
async function run(opts) {
  await sem.acquire();
  try { return await spawnClaude(opts); }
  finally { sem.release(); }
}
```

Fairness: FIFO over the wait queue, so a flood of `prReview` calls cannot starve executor stages.

### 2. Per-run keyed mutex (new `src/runLock.js`)

Existing `mutex.runExclusive(project.slug, ...)` serializes git operations per project. We add a separate keyed mutex over `runId` and acquire it around the entire claude-calling body in `prSweep` (resolveConflict path), `prReview` (handleRun body), and executor stages (which are already implicitly serial per-run but explicit lock makes it composable).

This makes the invariant **"at most one `claude -p` process is active for a given run at any instant"** a hard guarantee, regardless of which interval invoked it.

### 3. Tick re-entrancy guard (in `prSweep` and `prReview`)

Each tick gains:

```js
let running = false;
async function tick() {
  if (running) return;       // skip overlap
  running = true;
  try { /* current body */ }
  finally { running = false; }
}
```

This is the cheapest possible fix for the overlap loop. The interval continues to fire on schedule; if a tick is still in flight, the firing is dropped (not queued). For a 60s interval whose work occasionally takes 90s, you get the next tick at the 120s mark — desired behavior.

### 4. Per-run exponential backoff (DB-backed)

Schema additions (idempotent migration via the existing `PRAGMA table_info` pattern in `src/db.js`):

```sql
ALTER TABLE runs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE runs ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
```

Lifecycle:

- **On any `claude` failure** (non-zero exit, timeout, or stage throw) inside a run-scoped operation:
  `consecutive_failures += 1; next_attempt_at = now + min(BACKOFF_BASE_MS * 2^(failures-1), BACKOFF_MAX_MS)`
- **On `claude` success** for the run: `consecutive_failures = 0; next_attempt_at = NULL`
- All "pick eligible runs" queries (`scheduler.claimNext`, `prSweep.tick`, `prReview.tick`) add:
  `AND (next_attempt_at IS NULL OR next_attempt_at <= ?)` with `now` bound at query time.

Defaults: `BACKOFF_BASE_MS=60_000` (1 min), `BACKOFF_MAX_MS=3_600_000` (1 h). After 6 consecutive failures a run is parked for the cap; the operator can `cdev retry` or wait it out.

Why DB-backed rather than in-memory: survives service restarts, observable via `cdev logs`, and the `cdev runs` JSON can surface it.

### 5. Global circuit breaker (in `src/adapters/claude.js`)

In-memory ring buffer of the last N (default 10) `claude.run` outcomes (success/failure with timestamp). On each new call:

- If we're in `cooldown` (`cooldownUntil > now`) → reject immediately with `{code: 1, stdout: "", stderr: "circuit-breaker open", timedOut: false, cancelled: false}`. **No process spawned.** The caller observes this as a normal failure (its retry/backoff handles it).
- Otherwise, spawn. After the result, push to the ring; if (failures in last `WINDOW_MS`) / (samples in last `WINDOW_MS`) ≥ `FAILURE_RATIO` AND we have at least `MIN_SAMPLES` samples → set `cooldownUntil = now + COOLDOWN_MS`.
- First success after cooldown clears the ring.

Defaults: `WINDOW_MS=300_000` (5 min), `FAILURE_RATIO=0.8`, `MIN_SAMPLES=5`, `COOLDOWN_MS=900_000` (15 min). The breaker logs a single line per state transition (open / half-open probe / closed) — operator can see it in `journalctl`.

## Config (additions to `src/config.js`)

| Env | Default | Purpose |
|---|---|---|
| `MAX_CONCURRENT_RUNS` (existing) | 2 | Now the **global** `claude` concurrency cap, not just executor |
| `RUN_BACKOFF_BASE_MS` | 60000 | Base for exponential backoff |
| `RUN_BACKOFF_MAX_MS` | 3600000 | Cap on backoff (1 h) |
| `CLAUDE_CIRCUIT_WINDOW_MS` | 300000 | Rolling window for circuit breaker |
| `CLAUDE_CIRCUIT_MIN_SAMPLES` | 5 | Minimum samples before breaker can trip |
| `CLAUDE_CIRCUIT_FAILURE_RATIO` | 0.8 | Failure ratio that opens the breaker |
| `CLAUDE_CIRCUIT_COOLDOWN_MS` | 900000 | Cooldown after breaker opens |

## File changes

- **`src/adapters/claude.js`** — semaphore + circuit breaker around `run()`. Adapter factory takes `{ maxConcurrent, circuit: {...} }` injected from wire.
- **`src/runLock.js`** (new) — keyed async mutex over `runId`, same shape as the existing project-slug mutex.
- **`src/db.js`** — add two columns to `runs` via idempotent `PRAGMA table_info` migration (matching the existing pattern for `projects`).
- **`src/scheduler.js`** — `claimNext` query gets the `next_attempt_at` filter.
- **`src/prSweep.js`** — re-entrancy flag; per-run lock around the rebase/resolve/push block; failure/success → bump or clear `consecutive_failures`/`next_attempt_at`.
- **`src/prReview.js`** — re-entrancy flag; per-run lock around `handleRun`; outer catch and inner stage-error paths update backoff columns; success paths clear them.
- **`src/executor.js`** — per-run lock around stage invocations; failure/success update backoff columns. Note: executor already serializes its own pipeline per run, so the lock is mostly belt-and-suspenders, but it ensures executor and prSweep/prReview never collide on the same `runId` (e.g. an executor recovery path running alongside prReview).
- **`src/wire.js`** — construct circuit-breaker config from env, construct runLock, inject into adapter + factories.
- **`server.js`** — no changes (re-entrancy guard lives inside the tick functions; setInterval wiring untouched).
- **`test/`** — new units described below.

## Testing strategy

All offline with the existing fake-adapter seam.

1. **Semaphore cap** — `test/claude-semaphore.test.js`. Fake spawn that sleeps; assert at most `maxConcurrent` are simultaneously inside `run()`. Issue 10 calls, expect ≤2 running at any tick.
2. **Per-run lock** — invoke prSweep + prReview in parallel on the same `runId` with a slow fake; assert their inner bodies serialize (no interleaving of probe calls).
3. **Tick re-entrancy** — install a fake interval driver, fire `tick()` twice synchronously, assert the second returns immediately and only one body runs.
4. **Backoff** — drive a fake claude that always exits 1 against one run; tick 7 times; assert `next_attempt_at - now` after each failure is the series `60s, 120s, 240s, 480s, 960s, 1920s, 3600s` (the 7th failure is the cap kicking in: `60s·2^6 = 3840s` clamped to `BACKOFF_MAX_MS=3600s`). Then advance the clock past `next_attempt_at` and assert the run is re-eligible.
5. **Circuit breaker** — fake claude that returns 8 failures then 2 successes within the window; assert breaker opens after 5 failures with ratio ≥0.8, no spawns during cooldown, half-open probe spawns one call after cooldown, success closes the ring.
6. **End-to-end loop reproduction** — set up 3 fake `pr_open` runs, fake claude that always exits 1; run the wired intervals for 5 simulated minutes; assert total `claude.run` invocations are bounded by circuit breaker behavior (rough budget: ≤20 in 5 min, compared to ≥50 today).

## Migration & operational notes

- The two new columns default to NULL/0 — existing rows behave as eligible (next_attempt_at=NULL → not filtered). No data migration script needed.
- Restart procedure is unchanged: `systemctl --user restart headless-claude.service`. The `autonomous-dev wired:` log line gains the new caps so operators can confirm.
- `cdev runs` JSON output gains `next_attempt_at` and `consecutive_failures` so the operator can see why a run is parked.
- The 3 currently-stuck runs (20, 51, 27 on `acme-web`) will, on restart with these changes, have `next_attempt_at=NULL` and `consecutive_failures=0`. First failure with the still-exhausted quota will start the backoff clock; circuit breaker will trip after the first window. Operator can `cdev retry` to get a fresh worktree off the new `main`, which is the right move for these three regardless.

## Risks

- **Circuit breaker false-positive** during a transient flap unrelated to quota. Mitigation: `MIN_SAMPLES=5` and `WINDOW_MS=5min` mean a brief blip doesn't trip it; the cooldown is bounded.
- **Backoff starves a recoverable run** if it happens to consecutively fail for unrelated reasons. Mitigation: operator can `cdev retry` to reset (retry creates a new run row, consecutive_failures starts at 0).
- **Per-run lock interacts with project mutex** — both are non-reentrant. Acquire order matters: always project mutex *inside* run lock (run is the larger scope), never the reverse. Code-review item during implementation.

## Out of scope / followups

- Replacing `setInterval` with a unified work-queue worker (mentioned above).
- Adapting `claude` failure detection to read the actual stderr for quota messages (would let us trip the breaker faster but adds coupling to claude CLI output).
- Surfacing circuit-breaker state via a `/healthz/cdev` endpoint or the runs dashboard.
