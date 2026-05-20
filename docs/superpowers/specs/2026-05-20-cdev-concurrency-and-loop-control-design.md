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
- **Per-run cooldown** — after every `claude` invocation on a run (success or failure), wait at least `RUN_COOLDOWN_MS` (default 3 min) before the next one. Failures linearly extend this. The same run can't be hammered every 60s.
- **Global spawn pacing** — at most one new `claude` process is started per `CLAUDE_MIN_SPAWN_INTERVAL_MS` (default 3 min) across the whole subsystem. With healthy long-running calls and the concurrency cap, this rarely binds; with fast-failing calls (quota exhausted) it caps the burn at ~20 spawns/hour total.
- **Preserve healthy-path throughput.** A single run that needs to do real work (5–30 min claude call) is not artificially slowed by the cooldowns — they apply *between* spawns, not during one.

## Non-goals

- Replacing `setInterval` with a unified work-queue worker pool. (Considered: cleaner long-term, but a much larger refactor. Out of scope for this spec.)
- Changing the `claude -p` invocation contract or stage outputs.
- Touching the cspawn tmux pool subsystem (independent concern).
- Detecting "rate limit" vs other failures via stderr parsing. We treat any non-zero exit as a failure for cooldown/pacing purposes; that is sufficient because the loops happen on any consistent failure mode.
- A ring-buffer "circuit breaker" on top of the per-run cooldown + global pacing. The simpler two-knob design already bounds the spawn rate; a breaker is a follow-up if operators ever need a hard "stop everything for N minutes" lever.

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

### 4. Per-run cooldown (DB-backed) — fixed 3-minute floor between `claude` work on a run

This is the primary throttle. After **any** `claude` invocation on a run completes (success or failure), the run is parked for `RUN_COOLDOWN_MS` before the next interval can pick it up again. Failures extend the cooldown linearly. The goal is operator-visible: "each instance creation should be delayed ~3 minutes per run" — even healthy runs don't cycle through prReview faster than the cooldown.

Schema additions (idempotent migration via the existing `PRAGMA table_info` pattern in `src/db.js`):

```sql
ALTER TABLE runs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE runs ADD COLUMN consecutive_failures INTEGER DEFAULT 0;
```

Lifecycle (applied after every `claude` call inside a run-scoped operation):

- **On success:** `consecutive_failures = 0; next_attempt_at = now + RUN_COOLDOWN_MS`
- **On failure** (non-zero exit, timeout, or stage throw): `consecutive_failures += 1; next_attempt_at = now + min(RUN_COOLDOWN_MS * (1 + consecutive_failures), RUN_COOLDOWN_MAX_MS)`
- All "pick eligible runs" queries (`scheduler.claimNext`, `prSweep.tick`, `prReview.tick`) add: `AND (next_attempt_at IS NULL OR next_attempt_at <= ?)` with `now` bound at query time.

Default `RUN_COOLDOWN_MS=180_000` (3 min). Default `RUN_COOLDOWN_MAX_MS=3_600_000` (1 h). Linear (not exponential) escalation keeps reasoning simple: failure #1 → 6 min, #2 → 9 min, #3 → 12 min, #4 → 15 min, … #19 → 60 min cap. Consistent failures park a run within ~5 attempts of the cap.

Why DB-backed rather than in-memory: survives service restarts, observable via `cdev logs`, and the `cdev runs` JSON can surface it.

### 5. Global spawn-pacing gate (in `src/adapters/claude.js`)

Independent of per-run cooldown, the adapter enforces a **global minimum interval** between any two `claude` process spawns across the whole subsystem. After a spawn starts, the next acquirer of the semaphore must additionally wait until `lastSpawnAt + CLAUDE_MIN_SPAWN_INTERVAL_MS`. This prevents the runaway burst pattern observed in the journal (4 spawns on run 51 in 12s) regardless of how many overlapping ticks or queued runs are eligible.

```js
// inside createClaude.run, after sem.acquire()
const wait = Math.max(0, lastSpawnAt + minSpawnIntervalMs - Date.now());
if (wait > 0) await sleep(wait);
lastSpawnAt = Date.now();
// ...spawnClaude(opts)
```

Default `CLAUDE_MIN_SPAWN_INTERVAL_MS=180_000` (3 min). Combined with `MAX_CONCURRENT_RUNS=2`: when claude calls are healthy (typically 5–30 min each), the concurrency cap is the binding constraint and the pacing rarely adds delay. When claude exits fast (the failure mode that drove the original burn), the pacing is the binding constraint — at most one new spawn per 3 minutes, period.

Logging: on a state change (pacing actually applied, i.e. `wait > 0`), log one line `claude: spawn paced +Xs` to journalctl so operators can see when the throttle is active. No log on the no-op path.

Why this replaces the previous circuit-breaker design: the per-run cooldown already parks failing runs, and the global pacing already bounds the total spawn rate. Adding a ring-buffer circuit breaker on top would be additional complexity for the same effective outcome. If operators later need stronger "stop everything" semantics during a known outage, that can be a follow-up (see Out-of-scope).

## Config (additions to `src/config.js`)

| Env | Default | Purpose |
|---|---|---|
| `MAX_CONCURRENT_RUNS` (existing) | 2 | Now the **global** `claude` concurrency cap, not just executor |
| `RUN_COOLDOWN_MS` | 180000 (3 min) | Minimum delay between any two `claude` invocations on the same run, regardless of outcome |
| `RUN_COOLDOWN_MAX_MS` | 3600000 (1 h) | Cap on the cooldown after linear escalation from consecutive failures |
| `CLAUDE_MIN_SPAWN_INTERVAL_MS` | 180000 (3 min) | Global minimum interval between any two `claude` process spawns across the whole subsystem |

## File changes

- **`src/adapters/claude.js`** — semaphore + global spawn-pacing gate around `run()`. Adapter factory takes `{ bin, baseArgs, maxConcurrent, minSpawnIntervalMs, now, sleep }` (the `now` and `sleep` parameters are injected for test fake-clock control).
- **`src/runLock.js`** (new) — keyed async mutex over `runId`, same shape as the existing project-slug mutex.
- **`src/runCooldown.js`** (new) — single helper exporting `recordSuccess(db, runId, cfg, now)` and `recordFailure(db, runId, cfg, now)`, so the three call sites stay consistent and tests can verify exact column writes.
- **`src/db.js`** — add `next_attempt_at` + `consecutive_failures` columns to `runs` via idempotent `PRAGMA table_info` migration (matching the existing pattern for `projects`).
- **`src/scheduler.js`** — `claimNext` query gets the `next_attempt_at` filter.
- **`src/prSweep.js`** — re-entrancy flag; per-run lock around the rebase/resolve/push block; failure/success → call into `runCooldown` helper.
- **`src/prReview.js`** — re-entrancy flag; per-run lock around `handleRun`; outer catch and inner stage-error paths call `runCooldown.recordFailure`; success paths call `runCooldown.recordSuccess`.
- **`src/executor.js`** — per-run lock around stage invocations; failure/success update cooldown columns through the same helper. Executor already serializes its own pipeline per run, but the explicit lock prevents executor recovery paths from colliding with prSweep/prReview on the same `runId`.
- **`src/wire.js`** — read new env config, construct `runLock` + `runCooldown` helper, inject into adapter + factories.
- **`server.js`** — no changes (re-entrancy guard lives inside the tick functions; setInterval wiring untouched).
- **`test/`** — new units described below.

## Testing strategy

All tests run offline against the existing fake-adapter seam, using `openDb(':memory:')` for SQLite and injecting a fake `now()` clock so wall-clock time is deterministic. Every test below names: the test file, the exact constructor / method calls with params, the fake setup, and the assertions. The final two tests reproduce real end-user scenarios that would have prevented the 2026-05-20 incident.

Shared fake-clock helper used throughout:

```js
function fakeClock(initialMs) {
  let t = initialMs;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); }, // skip time for adapter pacing
    advance: (ms) => { t += ms; },
  };
}
```

### Unit tests

**T1. Concurrency semaphore caps simultaneous spawns — `test/claude-semaphore.test.js`**

```js
const clock = fakeClock(1_700_000_000_000);
let inside = 0, maxInside = 0;
const fakeSpawn = async () => {
  inside++; maxInside = Math.max(maxInside, inside);
  await new Promise(r => setTimeout(r, 30));
  inside--;
  return { code: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false };
};
const claude = createClaude({
  bin: "fake",
  maxConcurrent: 2,
  minSpawnIntervalMs: 0,            // pacing disabled to isolate semaphore behavior
  now: clock.now,
  sleep: clock.sleep,
  _spawn: fakeSpawn,                 // injection seam for the test
});

const results = await Promise.all(
  Array.from({ length: 10 }, () =>
    claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 60_000 })
  )
);

assert.equal(results.length, 10);
assert.equal(maxInside, 2, `expected ≤2 concurrent, saw ${maxInside}`);
assert.ok(results.every(r => r.code === 0));
```

**T2. Global spawn pacing enforces minimum interval — `test/claude-spawn-pacing.test.js`**

```js
const clock = fakeClock(0);
const spawnTimes = [];
const fakeSpawn = async () => {
  spawnTimes.push(clock.now());
  return { code: 0, stdout: "", stderr: "", timedOut: false, cancelled: false };
};
const claude = createClaude({
  bin: "fake",
  maxConcurrent: 5,                  // unlimited concurrency to isolate pacing
  minSpawnIntervalMs: 180_000,       // 3 min
  now: clock.now,
  sleep: clock.sleep,
  _spawn: fakeSpawn,
});

await claude.run({ cwd: "/tmp", prompt: "1", timeoutMs: 60_000 });
await claude.run({ cwd: "/tmp", prompt: "2", timeoutMs: 60_000 });
await claude.run({ cwd: "/tmp", prompt: "3", timeoutMs: 60_000 });

// First spawn at t=0, then each subsequent spawn must be ≥180_000 ms later.
assert.equal(spawnTimes[0], 0);
assert.equal(spawnTimes[1], 180_000);
assert.equal(spawnTimes[2], 360_000);
```

**T3. Per-run cooldown — success path sets the 3-minute floor — `test/run-cooldown.test.js`**

```js
const db = openDb(':memory:');
// seed: one project, one pr_open run
db.prepare("INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path) VALUES(1,'p','o/r','claude-dev','main','/tmp/p')").run();
db.prepare(`INSERT INTO runs(id,project_id,issue_number,state,branch,attempt,created_at,updated_at)
            VALUES(7, 1, 42, 'pr_open', 'claude/42-p', 1, '2026-05-20T00:00:00Z', '2026-05-20T00:00:00Z')`).run();

const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
const now = new Date('2026-05-20T01:00:00Z').getTime();

recordSuccess(db, 7, cfg, now);

const row = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
assert.equal(row.consecutive_failures, 0);
assert.equal(new Date(row.next_attempt_at).getTime(), now + 180_000);
```

**T4. Per-run cooldown — failure path extends linearly up to the cap — `test/run-cooldown.test.js`**

```js
const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
const t0 = new Date('2026-05-20T00:00:00Z').getTime();

// Simulate 25 consecutive failures and check the resulting cooldown each step.
const expected = []; // failure N → 180_000 * (1 + N), capped at 3_600_000
for (let n = 1; n <= 25; n++) {
  recordFailure(db, 7, cfg, t0);
  const row = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
  const delta = new Date(row.next_attempt_at).getTime() - t0;
  expected.push({ n, failures: row.consecutive_failures, delta });
}

// First few should be 360s, 540s, 720s, 900s, … (linear in n+1)
assert.equal(expected[0].delta,   360_000);   // n=1 → 180*(1+1)
assert.equal(expected[1].delta,   540_000);   // n=2 → 180*(1+2)
assert.equal(expected[2].delta,   720_000);   // n=3
// Cap kicks in at n=19 (180*20 = 3_600_000)
assert.equal(expected[18].delta, 3_600_000);
assert.equal(expected[19].delta, 3_600_000);  // capped
assert.equal(expected[24].delta, 3_600_000);  // still capped at n=25
```

**T5. Eligibility filter — scheduler / prSweep / prReview skip runs whose `next_attempt_at > now` — `test/run-cooldown-eligibility.test.js`**

```js
const db = openDb(':memory:');
seedProjectAndRuns(db, { runs: [
  { id: 1, state: 'queued', next_attempt_at: null },                      // eligible
  { id: 2, state: 'queued', next_attempt_at: '2026-05-20T00:01:00Z' },    // past → eligible
  { id: 3, state: 'queued', next_attempt_at: '2026-05-20T10:00:00Z' },    // future → blocked
]});

const scheduler = createScheduler({ db, executor: fakeExecutor, maxConcurrentRuns: 5, now: () => new Date('2026-05-20T00:30:00Z').getTime() });
await scheduler.tick();

assert.deepEqual(fakeExecutor.executed, [1, 2]); // run 3 was filtered out
```

**T6. Per-run lock prevents concurrent claude on the same run — `test/run-lock.test.js`**

```js
const runLock = createRunLock();
const order = [];
const slow = async (label) => {
  order.push(`enter:${label}`);
  await new Promise(r => setTimeout(r, 20));
  order.push(`exit:${label}`);
};

// Two callers race on the same run id (42).
await Promise.all([
  runLock.runExclusive(42, () => slow('A')),
  runLock.runExclusive(42, () => slow('B')),
]);

// Inner bodies must serialize (no interleaving):
assert.deepEqual(order, ['enter:A', 'exit:A', 'enter:B', 'exit:B']);
```

**T7. Tick re-entrancy guard — overlapping firings drop, not queue — `test/tick-reentrancy.test.js`**

```js
let entered = 0, finished = 0;
const slowBody = async () => { entered++; await new Promise(r => setTimeout(r, 50)); finished++; };
const prSweep = createPrSweep({ db, gh: fakeGh, workspace: fakeWs, stages: { ...fakeStages, runResolveConflict: slowBody }, config: cfg });

prSweep.tick(); // first call — body in flight for 50ms
prSweep.tick(); // synchronous second call — should be a no-op
prSweep.tick(); // third — also no-op

await new Promise(r => setTimeout(r, 100));

assert.equal(entered, 1);
assert.equal(finished, 1);
```

### End-user scenario integration tests

These reproduce the kinds of workflows an operator drives. Each spins up the full wired-DI graph from `buildAutonomous` with fakes for `gh`, `git`, and `claude`, drives the intervals with a fake clock, and asserts on observable outcomes (spawn count, DB state, eventual run state).

**S1. "Operator labels an issue → bot develops it" — `test/scenario-happy-path.test.js`**

The healthy-path baseline. Confirms the new throttles don't break normal flow.

```js
const clock = fakeClock(new Date('2026-05-20T12:00:00Z').getTime());
const sys = buildAutonomous({ env: { /* defaults */ }, _clock: clock, _fakes: { gh, git, claude: alwaysSucceeds } });

// Operator: gh issue create ... + apply 'claude-dev' label
fakeGh.queueLabeledIssue({ repo: 'o/r', number: 100, body: 'Add health endpoint' });

// One poll tick claims it; scheduler.tick runs executor; executor walks the pipeline.
await sys.poller.tick();
await sys.scheduler.drain();

const run = db.prepare("SELECT * FROM runs WHERE issue_number=100").get();
assert.equal(run.state, 'pr_open');
// One claude per stage, all on this run. With max=2 and a single run, parallelism never kicks in.
assert.equal(claude.spawnCount, 4); // spec_plan, implement, review, pr
```

**S2. "Operator labels 5 issues at once" — concurrency cap holds — `test/scenario-burst-labeling.test.js`**

```js
for (let i = 200; i < 205; i++) fakeGh.queueLabeledIssue({ repo: 'o/r', number: i, body: `feat ${i}` });

await sys.poller.tick(); // claims all 5
const tickP = sys.scheduler.tick(); // starts executing

// At any instant during the drain, no more than 2 claude processes are alive.
await tickP;
await sys.scheduler.drain();

assert.equal(claude.maxConcurrent, 2);          // semaphore enforced
assert.equal(claude.spawnCount, 5 * 4);          // 4 stages × 5 runs, eventually all complete
```

**S3. "Claude quota exhausted — the runaway burst is bounded" — `test/scenario-quota-exhausted.test.js`**

This is the 2026-05-20 incident as a regression test.

```js
const clock = fakeClock(new Date('2026-05-20T20:32:00Z').getTime());

// Three pr_open runs that are DIRTY against main (the conflicting-PR situation).
seedRuns(db, [
  { id: 20, state: 'pr_open', branch: 'claude/16-x', worktree_path: '/tmp/wt-20', last_synced_base_sha: 'old' },
  { id: 27, state: 'pr_open', branch: 'claude/46-x', worktree_path: '/tmp/wt-27', last_synced_base_sha: 'old' },
  { id: 51, state: 'pr_open', branch: 'claude/62-x', worktree_path: '/tmp/wt-51', last_synced_base_sha: 'old' },
]);
fakeGh.prStatus = async () => ({ state: 'OPEN', mergeStateStatus: 'DIRTY', number: 99 });
fakeClaude.behavior = () => ({ code: 1, stdout: '', stderr: '', timedOut: false, cancelled: false });

// Simulate 1 hour of wall-clock with 60s prSweep + 120s prReview firing on schedule.
for (let elapsed = 0; elapsed < 3600_000; elapsed += 60_000) {
  await sys.prSweep.tick();
  if (elapsed % 120_000 === 0) await sys.prReview.tick();
  clock.advance(60_000);
}

// Under the OLD behavior this loop produced ~150 claude spawns. Under the new behavior:
// - global spawn pacing caps at 1 spawn / 3 min = 20 spawns / hour
// - per-run cooldown linearly extends: run 20 hits 3min, 6min, 9min, ... gaps.
// We assert the upper bound, not exact, to keep the test resilient.
assert.ok(claude.spawnCount <= 25, `expected ≤25 spawns/hour, got ${claude.spawnCount}`);

// All three runs have escalating cooldowns and accumulated failures.
const rows = db.prepare("SELECT id, consecutive_failures FROM runs WHERE id IN (20,27,51)").all();
for (const r of rows) assert.ok(r.consecutive_failures >= 3, `run ${r.id} should have multiple failures recorded`);
```

**S4. "Operator runs `cdev retry` on a parked run — it becomes eligible again" — `test/scenario-retry-resets.test.js`**

```js
// Seed a run that has been failing for hours and is parked far in the future.
seedRuns(db, [
  { id: 51, state: 'failed', branch: 'claude/62-x', next_attempt_at: '2026-05-20T23:00:00Z', consecutive_failures: 19 },
]);

// Operator: `cdev retry 51` → POST /runs/51/retry
const res = await fetch(`${apiBase}/runs/51/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
assert.equal(res.status, 200);

// A NEW run row should exist with attempt=2, cooldown columns at their defaults.
const fresh = db.prepare("SELECT * FROM runs WHERE issue_number=(SELECT issue_number FROM runs WHERE id=51) AND attempt=2").get();
assert.ok(fresh);
assert.equal(fresh.consecutive_failures, 0);
assert.equal(fresh.next_attempt_at, null);
assert.equal(fresh.state, 'queued');
```

**S5. "Service restarts mid-cooldown — DB persistence preserves the throttle" — `test/scenario-restart-persists.test.js`**

```js
// Set up cooldowns, then close + reopen the DB to simulate a restart.
recordFailure(db, 7, cfg, t0);
recordFailure(db, 7, cfg, t0);
recordFailure(db, 7, cfg, t0);
const beforeRestart = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
db.close();

const db2 = openDb(dbPath);
const afterRestart = db2.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
assert.deepEqual(afterRestart, beforeRestart);
```

### Coverage summary

The unit tests (T1–T7) prove each primitive in isolation. Scenarios S1–S5 prove the wired system behaves correctly for the workflows the operator actually runs: labeling an issue, labeling many issues, the quota-exhausted incident, retrying a parked run, and surviving a restart. S3 is the explicit regression test for 2026-05-20 — it must fail against `main` today and pass after this design lands.

## Migration & operational notes

- The two new columns default to NULL/0 — existing rows behave as eligible (`next_attempt_at=NULL` → not filtered). No data migration script needed.
- Restart procedure is unchanged: `systemctl --user restart headless-claude.service`. The `autonomous-dev wired:` log line gains the new caps (`runCooldownMs`, `minSpawnIntervalMs`) so operators can confirm.
- `cdev runs` JSON output gains `next_attempt_at` and `consecutive_failures` so the operator can see why a run is parked, and roughly when the next attempt is due.
- The 3 currently-stuck runs (20, 51, 27 on `acme-web`) will, on restart with these changes, have `next_attempt_at=NULL` and `consecutive_failures=0`. First failure with the still-exhausted quota starts the cooldown clock. Combined with the 3-min global spawn-pacing, the worst-case spawn rate across all three is ~20/hour instead of the previous ~150+/hour. Operator can still `cdev retry` to get fresh worktrees off the new `main` — the right move for these three regardless.

## Risks

- **Cooldown starves a recoverable run** if it happens to consecutively fail for unrelated reasons. Mitigation: operator can `cdev retry` to reset (retry creates a new run row, `consecutive_failures=0`, `next_attempt_at=NULL`).
- **Per-run lock interacts with project mutex** — both are non-reentrant. Acquire order matters: always acquire the run lock *outside* the project mutex (run is the larger scope; the project mutex inside `workspace.rebaseOnBase` etc. is acquired by the workspace methods themselves). Inverting this risks self-deadlock. Code-review item during implementation; covered by T6 (per-run lock test).
- **Healthy-path latency** — adding the 3-min per-run cooldown means that even on the happy path, prReview's "approve + comment" pass on a freshly-pushed PR is delayed up to 3 min vs today. That's an acceptable trade for the loop protection; the prReview iteration cap is already 4, so total review wall-time is bounded.
- **Global pacing applied to executor stages** — when an issue is being developed, its 4 stages (spec_plan → implement → review → pr) will be spaced ≥3 min apart even if all four would otherwise complete back-to-back. Worst-case adds ~9 min to a new-issue pipeline. Acceptable; the stages themselves typically take far longer.

## Out of scope / followups

- Replacing `setInterval` with a unified work-queue worker (mentioned above).
- Adapting `claude` failure detection to read the actual stderr for quota messages (would let us escalate cooldowns faster but adds coupling to claude CLI output).
- Adding a hard "stop everything for N minutes" circuit breaker on top of the cooldown + pacing. Justified only if operators find the bounded-burn rate (~20/hour) still too aggressive during a known outage.
- Surfacing cooldown / pacing state via a `/healthz/cdev` endpoint or the runs dashboard.
