# cdev concurrency & loop control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the cdev subsystem from exhausting the operator's Claude subscription quota by adding three throttles (global concurrency semaphore, global spawn pacing, per-run cooldown) plus tick re-entrancy guards and a per-run lock, all enforced through a single shared `claude` adapter and three call sites (`executor`, `prSweep`, `prReview`).

**Architecture:** Two pure helpers (`src/runCooldown.js` + a second `createKeyedMutex` instance) plus a thin wrapper around the existing `createClaude` adapter handle all behavior. The three interval-driven runners (`prSweep`, `prReview`, executor stages) wrap their claude-calling bodies with the per-run lock and call the cooldown helper on success/failure. SQLite gains two new columns on `runs`. No new long-lived background loops; the existing `setInterval` wiring is unchanged.

**Tech Stack:** Node 20 ESM, `better-sqlite3`, Node's built-in `node:test`/`node:assert/strict`, existing fake-adapter seam in `test/`.

**Spec:** `docs/superpowers/specs/2026-05-20-cdev-concurrency-and-loop-control-design.md`

---

## File map

| File | Role |
|---|---|
| `src/config.js` | Read `RUN_COOLDOWN_MS`, `RUN_COOLDOWN_MAX_MS`, `CLAUDE_MIN_SPAWN_INTERVAL_MS` from env. |
| `src/db.js` | Idempotent migration: add `next_attempt_at TEXT`, `consecutive_failures INTEGER DEFAULT 0` to `runs`. |
| `src/runCooldown.js` (new) | `recordSuccess` / `recordFailure` helpers. Single source of truth for cooldown math. |
| `src/adapters/claude.js` | Add global concurrency semaphore + global spawn-pacing gate. New constructor params: `maxConcurrent`, `minSpawnIntervalMs`, `now`, `sleep`, `_spawn` (test seam). |
| `src/scheduler.js` | `claimNext` SQL gains `AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`. |
| `src/prSweep.js` | Tick re-entrancy flag; wrap per-run body with run-lock; on success/failure call `runCooldown.*`. |
| `src/prReview.js` | Tick re-entrancy flag; wrap `handleRun` with run-lock; on success/failure call `runCooldown.*`. |
| `src/executor.js` | Wrap `execute(runId)` body with run-lock; on success/failure call `runCooldown.*`. |
| `src/wire.js` | Instantiate a second `createKeyedMutex()` for runs, construct `runCooldown` config, inject into adapter + runners. |
| `test/*.test.js` (12 new) | Unit + scenario tests enumerated below. |

**Design note (deviation from spec):** the spec listed `src/runLock.js` (new) as a separate file. `src/mutex.js` already exports `createKeyedMutex()` whose shape is identical. We instantiate a second instance keyed by `runId` in `wire.js` instead of creating a duplicate file. Saves one file and matches the existing pattern.

---

## Task 1: Config knobs

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js` (existing — extend)

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.js`:

```js
test("loadConfig reads new throttle env vars with sensible defaults", () => {
  const c = loadConfig({});
  assert.equal(c.runCooldownMs, 180_000);
  assert.equal(c.runCooldownMaxMs, 3_600_000);
  assert.equal(c.claudeMinSpawnIntervalMs, 180_000);

  const overridden = loadConfig({
    RUN_COOLDOWN_MS: "60000",
    RUN_COOLDOWN_MAX_MS: "1800000",
    CLAUDE_MIN_SPAWN_INTERVAL_MS: "30000",
  });
  assert.equal(overridden.runCooldownMs, 60_000);
  assert.equal(overridden.runCooldownMaxMs, 1_800_000);
  assert.equal(overridden.claudeMinSpawnIntervalMs, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — undefined fields.

- [ ] **Step 3: Implement**

In `src/config.js`, inside the `return { ... }` object in `loadConfig`, append three keys:

```js
    runCooldownMs: num(env.RUN_COOLDOWN_MS, 180000),
    runCooldownMaxMs: num(env.RUN_COOLDOWN_MAX_MS, 3600000),
    claudeMinSpawnIntervalMs: num(env.CLAUDE_MIN_SPAWN_INTERVAL_MS, 180000),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): add runCooldownMs, runCooldownMaxMs, claudeMinSpawnIntervalMs"
```

---

## Task 2: DB migration — add cooldown columns

**Files:**
- Modify: `src/db.js:55-68` (the `runMigrations` block)
- Test: `test/db-cooldown-columns.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/db-cooldown-columns.test.js`:

```js
// test/db-cooldown-columns.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

const NEW_COLS = ["next_attempt_at", "consecutive_failures"];

test("fresh :memory: db has cooldown columns on runs", () => {
  const db = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(runs)").all().map((r) => r.name);
  for (const c of NEW_COLS) assert.ok(cols.includes(c), `missing ${c}`);
});

test("openDb migrates a pre-existing runs table WITHOUT cooldown columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-cd-"));
  const dbPath = join(dir, "test.db");
  try {
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, project_id INTEGER, issue_number INTEGER,
        parent_run_id INTEGER, state TEXT, worktree_path TEXT, branch TEXT,
        pr_url TEXT, attempt INTEGER DEFAULT 1, fail_reason TEXT,
        last_synced_base_sha TEXT, needs_attention INTEGER DEFAULT 0,
        attention_reason TEXT, created_at TEXT, updated_at TEXT);
    `);
    old.prepare(
      "INSERT INTO runs (project_id,issue_number,state,created_at,updated_at) VALUES (1,1,'pr_open','t','t')",
    ).run();
    old.close();

    const db = openDb(dbPath);
    const cols = db.prepare("PRAGMA table_info(runs)").all().map((r) => r.name);
    for (const c of NEW_COLS) assert.ok(cols.includes(c), `missing ${c}`);
    const row = db.prepare("SELECT * FROM runs WHERE id=1").get();
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.next_attempt_at, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-cooldown-columns.test.js`
Expected: FAIL — columns missing.

- [ ] **Step 3: Implement**

In `src/db.js`, modify the `runMigrations` array (currently at lines 55-60). Add the two new tuples:

```js
  const runMigrations = [
    ["pr_phase", "TEXT"],
    ["pr_reviewed_diff_id", "TEXT"],
    ["pr_review_iterations", "INTEGER DEFAULT 0"],
    ["pr_last_comment_at", "TEXT"],
    ["next_attempt_at", "TEXT"],
    ["consecutive_failures", "INTEGER DEFAULT 0"],
  ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-cooldown-columns.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db-cooldown-columns.test.js
git commit -m "feat(db): add next_attempt_at + consecutive_failures cooldown columns to runs"
```

---

## Task 3: `runCooldown` helper

**Files:**
- Create: `src/runCooldown.js`
- Test: `test/run-cooldown.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/run-cooldown.test.js`:

```js
// test/run-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { recordSuccess, recordFailure } from "../src/runCooldown.js";

function seedRun(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(7,1,42,'pr_open',1,'t','t')",
  ).run();
}

test("recordSuccess clears failures and parks for runCooldownMs", () => {
  const db = openDb(":memory:");
  seedRun(db);
  const now = 1_700_000_000_000;
  recordSuccess(db, 7, { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 }, now);
  const r = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
  assert.equal(r.consecutive_failures, 0);
  assert.equal(new Date(r.next_attempt_at).getTime(), now + 180_000);
});

test("recordFailure escalates linearly and caps at runCooldownMaxMs", () => {
  const db = openDb(":memory:");
  seedRun(db);
  const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
  const now = 1_700_000_000_000;
  const deltas = [];
  for (let n = 1; n <= 25; n++) {
    recordFailure(db, 7, cfg, now);
    const r = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
    deltas.push({ n, failures: r.consecutive_failures, delta: new Date(r.next_attempt_at).getTime() - now });
  }
  assert.equal(deltas[0].failures, 1);
  assert.equal(deltas[0].delta, 360_000);   // 180 * (1+1)
  assert.equal(deltas[1].delta, 540_000);   // 180 * (1+2)
  assert.equal(deltas[2].delta, 720_000);   // 180 * (1+3)
  assert.equal(deltas[18].delta, 3_600_000); // 180 * 20 — exactly cap
  assert.equal(deltas[19].delta, 3_600_000); // capped
  assert.equal(deltas[24].delta, 3_600_000); // still capped
  assert.equal(deltas[24].failures, 25);
});

test("recordSuccess after failures resets the counter", () => {
  const db = openDb(":memory:");
  seedRun(db);
  const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
  const now = 1_700_000_000_000;
  recordFailure(db, 7, cfg, now);
  recordFailure(db, 7, cfg, now);
  recordSuccess(db, 7, cfg, now);
  const r = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
  assert.equal(r.consecutive_failures, 0);
  assert.equal(new Date(r.next_attempt_at).getTime(), now + 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/run-cooldown.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/runCooldown.js`:

```js
// src/runCooldown.js
// Single source of truth for the per-run cooldown math.
//
// Lifecycle:
//   recordSuccess → consecutive_failures = 0;
//                   next_attempt_at = now + runCooldownMs
//   recordFailure → consecutive_failures += 1;
//                   next_attempt_at = now + min(runCooldownMs * (1 + cf),
//                                               runCooldownMaxMs)

export function recordSuccess(db, runId, cfg, nowMs = Date.now()) {
  const next = new Date(nowMs + cfg.runCooldownMs).toISOString();
  db.prepare(
    "UPDATE runs SET consecutive_failures=0, next_attempt_at=?, updated_at=? WHERE id=?",
  ).run(next, new Date(nowMs).toISOString(), runId);
}

export function recordFailure(db, runId, cfg, nowMs = Date.now()) {
  const row = db
    .prepare("SELECT consecutive_failures FROM runs WHERE id=?")
    .get(runId);
  const failures = (row && row.consecutive_failures ? row.consecutive_failures : 0) + 1;
  const delay = Math.min(cfg.runCooldownMs * (1 + failures), cfg.runCooldownMaxMs);
  const next = new Date(nowMs + delay).toISOString();
  db.prepare(
    "UPDATE runs SET consecutive_failures=?, next_attempt_at=?, updated_at=? WHERE id=?",
  ).run(failures, next, new Date(nowMs).toISOString(), runId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/run-cooldown.test.js`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/runCooldown.js test/run-cooldown.test.js
git commit -m "feat(runCooldown): recordSuccess/recordFailure helpers with linear backoff cap"
```

---

## Task 4: Concurrency semaphore in `createClaude`

**Files:**
- Modify: `src/adapters/claude.js`
- Test: `test/claude-semaphore.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/claude-semaphore.test.js`:

```js
// test/claude-semaphore.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

test("semaphore caps simultaneous spawns at maxConcurrent", async () => {
  let inside = 0;
  let maxInside = 0;
  const fakeSpawn = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
    return { code: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false };
  };

  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 2,
    minSpawnIntervalMs: 0,
    _spawn: fakeSpawn,
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 60_000 }),
    ),
  );

  assert.equal(results.length, 10);
  assert.equal(maxInside, 2, `expected ≤2 concurrent, saw ${maxInside}`);
  assert.ok(results.every((r) => r.code === 0));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude-semaphore.test.js`
Expected: FAIL — `maxConcurrent`/`_spawn` not honored, all 10 spawn at once.

- [ ] **Step 3: Implement — refactor `createClaude` to add the semaphore and a `_spawn` seam**

Replace the entire contents of `src/adapters/claude.js` with:

```js
// src/adapters/claude.js
import { spawn } from "node:child_process";

function createSemaphore(max) {
  let inFlight = 0;
  const waiters = [];
  return {
    async acquire() {
      if (inFlight < max) { inFlight++; return; }
      await new Promise((r) => waiters.push(r));
      inFlight++;
    },
    release() {
      inFlight--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

export function createClaude({
  bin,
  baseArgs,
  maxConcurrent = Infinity,
  minSpawnIntervalMs = 0,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  _spawn,            // test seam: when set, replaces the actual child_process.spawn path
} = {}) {
  const exe = bin || "/home/talhabera/.local/bin/claude";
  const args =
    baseArgs || ["-p", "--dangerously-skip-permissions", "--output-format", "text"];

  const sem = createSemaphore(maxConcurrent);
  let lastSpawnAt = -Infinity;

  async function applyPacing() {
    const wait = Math.max(0, lastSpawnAt + minSpawnIntervalMs - now());
    if (wait > 0) {
      // Single line, only on the wait path. Operator visibility.
      // eslint-disable-next-line no-console
      console.log(`claude: spawn paced +${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    lastSpawnAt = now();
  }

  function realSpawn({ cwd, prompt, timeoutMs, signal }) {
    if (signal && signal.aborted) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: false, cancelled: true });
    }
    return new Promise((resolve) => {
      const child = spawn(exe, args, { cwd });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const onAbort = () => { cancelled = true; child.kill("SIGKILL"); };
      if (signal) signal.addEventListener("abort", onAbort);

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code: code === null ? 1 : code, stdout, stderr, timedOut, cancelled });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code: 1, stdout, stderr: String(e), timedOut, cancelled });
      });
      child.stdin.end(prompt);
    });
  }

  return {
    async run(opts) {
      const { signal } = opts || {};
      if (signal && signal.aborted) {
        return { code: 1, stdout: "", stderr: "", timedOut: false, cancelled: true };
      }
      await sem.acquire();
      try {
        await applyPacing();
        return await (_spawn ? _spawn(opts) : realSpawn(opts));
      } finally {
        sem.release();
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/claude-semaphore.test.js test/claude.test.js test/claude-cancel.test.js`
Expected: PASS — semaphore test green, AND existing claude tests still pass (real-spawn path unchanged when `_spawn` not provided).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude.js test/claude-semaphore.test.js
git commit -m "feat(claude): global concurrency semaphore + _spawn test seam"
```

---

## Task 5: Global spawn pacing in `createClaude`

**Files:**
- Test: `test/claude-spawn-pacing.test.js` (new)

(Implementation is already in place from Task 4 — this task verifies it.)

- [ ] **Step 1: Write the failing test**

Create `test/claude-spawn-pacing.test.js`:

```js
// test/claude-spawn-pacing.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

function fakeClock(initialMs) {
  let t = initialMs;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

test("global pacing spaces consecutive spawns by minSpawnIntervalMs", async () => {
  const clock = fakeClock(0);
  const spawnTimes = [];
  const fakeSpawn = async () => {
    spawnTimes.push(clock.now());
    return { code: 0, stdout: "", stderr: "", timedOut: false, cancelled: false };
  };
  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 5,            // larger than call count — pacing is the only constraint
    minSpawnIntervalMs: 180_000,
    now: clock.now,
    sleep: clock.sleep,
    _spawn: fakeSpawn,
  });

  await claude.run({ cwd: "/tmp", prompt: "1", timeoutMs: 60_000 });
  await claude.run({ cwd: "/tmp", prompt: "2", timeoutMs: 60_000 });
  await claude.run({ cwd: "/tmp", prompt: "3", timeoutMs: 60_000 });

  assert.equal(spawnTimes[0], 0);
  assert.equal(spawnTimes[1], 180_000);
  assert.equal(spawnTimes[2], 360_000);
});

test("pacing applies even when prior spawn was fast/failing", async () => {
  const clock = fakeClock(0);
  const spawnTimes = [];
  const fakeSpawn = async () => {
    spawnTimes.push(clock.now());
    return { code: 1, stdout: "", stderr: "limit", timedOut: false, cancelled: false };
  };
  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 5,
    minSpawnIntervalMs: 180_000,
    now: clock.now,
    sleep: clock.sleep,
    _spawn: fakeSpawn,
  });

  await claude.run({ cwd: "/tmp", prompt: "1", timeoutMs: 60_000 });
  await claude.run({ cwd: "/tmp", prompt: "2", timeoutMs: 60_000 });

  assert.equal(spawnTimes[1] - spawnTimes[0], 180_000);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/claude-spawn-pacing.test.js`
Expected: PASS, 2/2.

- [ ] **Step 3: Commit**

```bash
git add test/claude-spawn-pacing.test.js
git commit -m "test(claude): pacing test covers happy + fast-fail paths"
```

---

## Task 6: Scheduler eligibility filter

**Files:**
- Modify: `src/scheduler.js` (the SQL inside `claimNext`)
- Test: `test/scheduler-cooldown.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-cooldown.test.js`:

```js
// test/scheduler-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createScheduler } from "../src/scheduler.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  // r1: eligible (no cooldown)
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(1,1,1,'queued',1,'t','t')",
  ).run();
  // r2: eligible (cooldown in the past)
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at,next_attempt_at) VALUES(2,1,2,'queued',1,'t','t','2020-01-01T00:00:00Z')",
  ).run();
  // r3: blocked (cooldown in the future)
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at,next_attempt_at) VALUES(3,1,3,'queued',1,'t','t','2099-01-01T00:00:00Z')",
  ).run();
}

test("scheduler skips runs whose next_attempt_at is in the future", async () => {
  const db = openDb(":memory:");
  seed(db);
  const executed = [];
  const fakeExecutor = {
    execute: async (id) => {
      executed.push(id);
      db.prepare("UPDATE runs SET state='pr_open' WHERE id=?").run(id);
    },
  };
  const sched = createScheduler({ db, executor: fakeExecutor, maxConcurrentRuns: 5 });
  await sched.drain();
  assert.deepEqual(executed.sort(), [1, 2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-cooldown.test.js`
Expected: FAIL — run 3 also executed.

- [ ] **Step 3: Implement**

In `src/scheduler.js`, replace the `claimNext` function body. The new SQL parameterizes `now` as the first bound parameter, with the existing `excluded` set bound after:

```js
  function claimNext(extraExcluded) {
    const excluded = new Set(inFlight);
    if (extraExcluded) for (const id of extraExcluded) excluded.add(id);
    const now = new Date().toISOString();
    const placeholders = [...excluded].map(() => "?").join(",") || "0";
    const row = db
      .prepare(
        `SELECT id FROM runs
           WHERE state='queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND id NOT IN (${placeholders})
           ORDER BY id LIMIT 1`,
      )
      .get(now, ...excluded);
    return row ? row.id : null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-cooldown.test.js test/scheduler.test.js`
Expected: PASS for new test, no regressions in existing scheduler tests.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.js test/scheduler-cooldown.test.js
git commit -m "feat(scheduler): claimNext filters runs whose next_attempt_at is in the future"
```

---

## Task 7: `prSweep` — tick re-entrancy + run lock + cooldown

**Files:**
- Modify: `src/prSweep.js` (full rewrite — file is short)
- Test: `test/prSweep-cooldown.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/prSweep-cooldown.test.js`:

```js
// test/prSweep-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrSweep } from "../src/prSweep.js";

const CFG = { stageTimeoutMs: 1000, runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };

function seedOpenRun(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,worktree_path,branch,attempt,created_at,updated_at,needs_attention) VALUES(7,1,42,'pr_open','/tmp/wt-7','claude/42-p',1,'t','t',0)",
  ).run();
}

test("prSweep tick is re-entrant-safe: a second concurrent tick is a no-op", async () => {
  const db = openDb(":memory:");
  seedOpenRun(db);
  let inFlight = 0, maxInFlight = 0, callCount = 0;
  const slowGh = {
    prStatus: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      callCount++;
      inFlight--;
      return { state: "OPEN", mergeStateStatus: "CLEAN", number: 99 };
    },
  };
  const sweep = createPrSweep({
    db, gh: slowGh, workspace: {}, stages: {}, config: CFG,
    runLock: createKeyedMutex(),
  });

  // Fire two ticks back-to-back; the second must skip.
  const a = sweep.tick();
  const b = sweep.tick();
  await Promise.all([a, b]);

  assert.equal(maxInFlight, 1);
  assert.equal(callCount, 1);
});

test("prSweep records cooldown on failure and skips runs whose next_attempt_at is future", async () => {
  const db = openDb(":memory:");
  seedOpenRun(db);
  // Park the run in the future — sweep must skip it.
  db.prepare("UPDATE runs SET next_attempt_at='2099-01-01T00:00:00Z' WHERE id=7").run();
  let prStatusCalled = false;
  const sweep = createPrSweep({
    db,
    gh: { prStatus: async () => { prStatusCalled = true; return { state: "OPEN", mergeStateStatus: "DIRTY", number: 99 }; } },
    workspace: {}, stages: {}, config: CFG,
    runLock: createKeyedMutex(),
  });
  await sweep.tick();
  assert.equal(prStatusCalled, false, "sweep must skip parked runs at the SQL level");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prSweep-cooldown.test.js`
Expected: FAIL — current `prSweep` has no re-entrancy guard, no `runLock` param, no `next_attempt_at` filter.

- [ ] **Step 3: Implement — rewrite `src/prSweep.js`**

```js
// src/prSweep.js
import { recordSuccess, recordFailure } from "./runCooldown.js";

export function createPrSweep({ db, gh, workspace, stages, config, runLock, now = () => Date.now() }) {
  let running = false;

  async function tick() {
    if (running) return;            // drop overlapping firings
    running = true;
    try {
      const projects = db.prepare("SELECT * FROM projects").all();
      const nowIso = new Date(now()).toISOString();
      for (const p of projects) {
        const runs = db
          .prepare(
            `SELECT * FROM runs
               WHERE project_id=? AND state='pr_open' AND needs_attention=0
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
          )
          .all(p.id, nowIso);

        for (const r of runs) {
          await runLock.runExclusive(r.id, () => handleRun(p, r));
        }
      }
    } finally {
      running = false;
    }
  }

  async function handleRun(p, r) {
    let status;
    try {
      status = await gh.prStatus(p.repo, r.branch);
    } catch {
      return;
    }
    if (status.state !== "OPEN") return;
    const behind = ["BEHIND", "DIRTY", "UNKNOWN"].includes(status.mergeStateStatus);
    if (!behind) return;
    if (!r.worktree_path) return; // worktree gone post-PR; skip (manual)

    let claudeFailed = false;
    try {
      const rb = await workspace.rebaseOnBase(p, r.worktree_path);
      if (rb.conflicted) {
        try {
          await stages.runResolveConflict({
            claude: stages.claude,
            cwd: r.worktree_path,
            files: rb.files || [],
            timeoutMs: config.stageTimeoutMs,
          });
        } catch (e) {
          claudeFailed = true;
          try { await workspace.abortRebase(p, r.worktree_path); } catch {}
          db.prepare(
            "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
          ).run(e.message, r.id);
          try { await gh.comment(p.repo, r.issue_number, `PR rebase blocked: ${e.message}`); } catch {}
          recordFailure(db, r.id, config, now());
          return;
        }
      }
      try {
        await workspace.pushBranch(p, r.worktree_path, r.branch);
      } catch (e) {
        claudeFailed = true;
        db.prepare(
          "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
        ).run(`push failed: ${e.message}`, r.id);
        recordFailure(db, r.id, config, now());
        return;
      }
    } finally {
      if (!claudeFailed) recordSuccess(db, r.id, config, now());
    }
  }

  return { tick };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/prSweep-cooldown.test.js`
Expected: PASS, 2/2. Existing `test/cdev*.test.js` and integration tests that exercise prSweep must still pass — see Step 5.

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `node --test`
Expected: All existing tests still pass. Any test that constructs `createPrSweep` directly without `runLock` will fail with "Cannot read properties of undefined (reading 'runExclusive')" — fix those by passing `runLock: createKeyedMutex()` in the test setup. Search and patch.

```bash
grep -rln "createPrSweep(" test/
```

For each hit, add `runLock: createKeyedMutex()` to the args.

- [ ] **Step 6: Commit**

```bash
git add src/prSweep.js test/prSweep-cooldown.test.js test/*.test.js
git commit -m "feat(prSweep): tick re-entrancy guard + per-run lock + cooldown integration"
```

---

## Task 8: `prReview` — tick re-entrancy + run lock + cooldown

**Files:**
- Modify: `src/prReview.js`
- Test: `test/prReview-cooldown.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/prReview-cooldown.test.js`:

```js
// test/prReview-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrReview } from "../src/prReview.js";

const CFG = {
  stageTimeoutMs: 1000,
  prReviewMaxIterations: 4,
  runCooldownMs: 180_000,
  runCooldownMaxMs: 3_600_000,
  botLogin: "bot",
};

function seedOpenRun(db, wtPath) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,worktree_path,branch,attempt,created_at,updated_at,needs_attention) VALUES(7,1,42,'pr_open',?,'claude/42-p',1,'t','t',0)",
  ).run(wtPath);
}

test("prReview tick is re-entrant: a second concurrent tick is a no-op", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hc-prr-"));
  try {
    const db = openDb(":memory:");
    seedOpenRun(db, tmp);
    let calls = 0;
    const gh = {
      prStatus: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { state: "OPEN", number: 99 }; },
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
    };
    const review = createPrReview({
      db, gh, workspace: { diffFingerprint: async () => "fp", pushBranch: async () => {} },
      stages: { runPrReview: async () => ({ verdict: "approve" }), runPrFix: async () => ({ ok: true, summary: "" }) },
      claude: {}, config: CFG, runLock: createKeyedMutex(),
    });
    const a = review.tick();
    const b = review.tick();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prReview records failure when a stage throws (claude exit 1 path)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hc-prr2-"));
  try {
    const db = openDb(":memory:");
    seedOpenRun(db, tmp);
    // Cold-start: no comments → first tick records baseline and skips. Set the watermark up-front.
    db.prepare("UPDATE runs SET pr_last_comment_at='2020-01-01T00:00:00Z' WHERE id=7").run();
    const gh = {
      prStatus: async () => ({ state: "OPEN", number: 99 }),
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
    };
    const review = createPrReview({
      db, gh,
      workspace: { diffFingerprint: async () => "fp", pushBranch: async () => {} },
      stages: {
        runPrReview: async () => { throw new Error("claude exited 1"); },
        runPrFix: async () => ({ ok: true, summary: "" }),
      },
      claude: {}, config: CFG, runLock: createKeyedMutex(),
    });
    await review.tick();
    const r = db.prepare("SELECT consecutive_failures, next_attempt_at FROM runs WHERE id=7").get();
    assert.equal(r.consecutive_failures, 1);
    assert.ok(r.next_attempt_at, "next_attempt_at should be set after a failure");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prReview-cooldown.test.js`
Expected: FAIL — neither re-entrancy nor cooldown is in place.

- [ ] **Step 3: Implement — modify `src/prReview.js`**

Make these targeted edits to the file:

**3a.** Replace the `createPrReview` signature and add `running` flag and `runCooldown` import. At the top of the file, change:

```js
import { existsSync } from "node:fs";
```

to:

```js
import { existsSync } from "node:fs";
import { recordSuccess, recordFailure } from "./runCooldown.js";
```

**3b.** Replace the `createPrReview` factory signature and `tick` body. Original signature:

```js
export function createPrReview({ db, gh, workspace, stages, claude, config }) {
```

New signature:

```js
export function createPrReview({ db, gh, workspace, stages, claude, config, runLock, now = () => Date.now() }) {
```

**3c.** Replace the `tick` body. Original:

```js
  async function tick() {
    const projects = db.prepare("SELECT * FROM projects").all();
    for (const p of projects) {
      const runs = db
        .prepare("SELECT * FROM runs WHERE project_id=? AND state='pr_open'")
        .all(p.id);
      for (const r of runs) {
        try {
          await handleRun(p, r);
        } catch (e) {
          db.prepare(
            "UPDATE runs SET updated_at=? WHERE id=?",
          ).run(new Date().toISOString(), r.id);
          // eslint-disable-next-line no-console
          console.error(`prReview run ${r.id}: ${e.message}`);
        }
      }
    }
  }
```

Replace with:

```js
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const projects = db.prepare("SELECT * FROM projects").all();
      const nowIso = new Date(now()).toISOString();
      for (const p of projects) {
        const runs = db
          .prepare(
            `SELECT * FROM runs
               WHERE project_id=? AND state='pr_open'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
          )
          .all(p.id, nowIso);
        for (const r of runs) {
          await runLock.runExclusive(r.id, async () => {
            try {
              await handleRun(p, r);
              recordSuccess(db, r.id, config, now());
            } catch (e) {
              recordFailure(db, r.id, config, now());
              // eslint-disable-next-line no-console
              console.error(`prReview run ${r.id}: ${e.message}`);
            }
          });
        }
      }
    } finally {
      running = false;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/prReview-cooldown.test.js test/prReview.test.js` (and any other prReview-touching tests).
Expected: PASS for new test. Existing `prReview` tests that construct `createPrReview` directly without `runLock` will fail until they are updated — patch them the same way as Task 7, Step 5.

```bash
grep -rln "createPrReview(" test/
```

Add `runLock: createKeyedMutex()` to each call.

- [ ] **Step 5: Commit**

```bash
git add src/prReview.js test/prReview-cooldown.test.js test/*.test.js
git commit -m "feat(prReview): tick re-entrancy guard + per-run lock + cooldown integration"
```

---

## Task 9: Executor — run lock + cooldown

**Files:**
- Modify: `src/executor.js`
- Test: `test/executor-cooldown.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/executor-cooldown.test.js`:

```js
// test/executor-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createExecutor } from "../src/executor.js";

const CFG = {
  stageTimeoutMs: 1000,
  runCooldownMs: 180_000,
  runCooldownMaxMs: 3_600_000,
  keepFailedWorktree: false,
};

function seedQueued(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(11,1,77,'queued',1,'t','t')",
  ).run();
}

test("executor failure path records cooldown failure", async () => {
  const db = openDb(":memory:");
  seedQueued(db);
  const executor = createExecutor({
    db,
    gh: { issue: async () => { throw new Error("gh down"); }, swapLabel: async () => {}, comment: async () => {} },
    workspace: { prepareClone: async () => "sha", addWorktree: async () => ({ path: "/tmp/wt", branch: "claude/77-p" }), removeWorktree: async () => {} },
    stages: { claude: {} },
    decompose: async () => {},
    config: CFG,
    git: () => ({ code: 0, stdout: "", stderr: "" }),
    preview: { maybeDeployPreview: async () => {} },
    runLock: createKeyedMutex(),
  });
  await executor.execute(11);
  const r = db.prepare("SELECT state, consecutive_failures FROM runs WHERE id=11").get();
  assert.equal(r.state, "failed");
  assert.equal(r.consecutive_failures, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/executor-cooldown.test.js`
Expected: FAIL — executor doesn't accept `runLock` and doesn't call `recordFailure`.

- [ ] **Step 3: Implement — modify `src/executor.js`**

**3a.** Add the import at top:

```js
import { recordSuccess, recordFailure } from "./runCooldown.js";
```

**3b.** Change the factory signature. Find:

```js
export function createExecutor({ db, gh, workspace, stages, decompose, config, git, preview }) {
```

Replace with:

```js
export function createExecutor({ db, gh, workspace, stages, decompose, config, git, preview, runLock, now = () => Date.now() }) {
```

**3c.** Wrap the body of `execute(runId)` with the run lock and add cooldown bookkeeping. The current shape:

```js
  async function execute(runId) {
    const ac = new AbortController();
    active.set(runId, ac);
    try {
      let run = getRun(runId);
      const project = getProject(run.project_id);
      try {
        // ... pipeline body ...
      } catch (e) {
        // existing fail() handling
      }
    } finally {
      active.delete(runId);
    }
  }
```

Wrap with `runLock.runExclusive(runId, ...)` and call `recordSuccess` / `recordFailure` at the boundaries:

```js
  async function execute(runId) {
    return runLock.runExclusive(runId, async () => {
      const ac = new AbortController();
      active.set(runId, ac);
      let success = false;
      try {
        // ... entire existing body verbatim ...
        // Set `success = true` immediately before the existing `return;` in the success path
        // (the `pr_open` transition is the success boundary — find the line:
        //    transition(db, run.id, "pr_open", { stage: "pr", message: "opened" });
        // and add `success = true;` right after it).
      } finally {
        if (success) recordSuccess(db, runId, config, now());
        else recordFailure(db, runId, config, now());
        active.delete(runId);
      }
    });
  }
```

Engineer note: the executor's existing happy path ends with the `transition(...,"pr_open",...)` call. Set `success = true` on the line immediately after that transition. The `decomposed` path is also a terminal success — set `success = true` immediately after the `transition(...,"decomposed",...)` call as well. The `failed` path naturally leaves `success = false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/executor-cooldown.test.js test/executor.test.js test/executor-rebase.test.js test/executor-cancel.test.js test/executor-keep-worktree.test.js test/executor-preview.test.js`
Expected: PASS for new test. Existing executor tests that construct `createExecutor` without `runLock` must be patched the same way as previous tasks.

```bash
grep -rln "createExecutor(" test/
```

Add `runLock: createKeyedMutex()` to each call.

- [ ] **Step 5: Commit**

```bash
git add src/executor.js test/executor-cooldown.test.js test/*.test.js
git commit -m "feat(executor): per-run lock + cooldown bookkeeping at success/failure boundaries"
```

---

## Task 10: Wire it up in `src/wire.js`

**Files:**
- Modify: `src/wire.js`
- Test: `test/wire-cooldown.test.js` (new) — smoke test that `buildAutonomous` constructs without errors and the new wiring is present.

- [ ] **Step 1: Write the failing test**

Create `test/wire-cooldown.test.js`:

```js
// test/wire-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAutonomous } from "../src/wire.js";

test("buildAutonomous wires runCooldown config + runLock without crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "hc-wire-"));
  try {
    const env = {
      HOME: root,
      AUTONOMOUS_DIR: join(root, "auto"),
      PROJECTS_DIR: join(root, "auto", "projects"),
      WORKTREES_DIR: join(root, "auto", "worktrees"),
      DB_PATH: join(root, "auto", "auto.db"),
    };
    // Pre-create dirs (openDb does not mkdir parents — see CLAUDE.md).
    const fs = await import("node:fs");
    fs.mkdirSync(env.PROJECTS_DIR, { recursive: true });
    fs.mkdirSync(env.WORKTREES_DIR, { recursive: true });

    const sys = buildAutonomous({ env });
    assert.equal(sys.config.runCooldownMs, 180_000);
    assert.equal(sys.config.runCooldownMaxMs, 3_600_000);
    assert.equal(sys.config.claudeMinSpawnIntervalMs, 180_000);
    assert.ok(sys.prSweep && typeof sys.prSweep.tick === "function");
    assert.ok(sys.prReview && typeof sys.prReview.tick === "function");
    assert.ok(sys.executor && typeof sys.executor.execute === "function");
    sys.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Note: `node:test` allows top-level `await` inside a sync test body via the dynamic import; mark the test fn `async` if needed:

```js
test("buildAutonomous wires runCooldown config + runLock without crashing", async () => {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/wire-cooldown.test.js`
Expected: FAIL — adapter/factories don't yet receive the new wiring.

- [ ] **Step 3: Implement — modify `src/wire.js`**

In the body of `buildAutonomous`, replace the three relevant lines:

**3a.** Replace the `claude` adapter construction:

```js
  const claude = createClaude({ bin: config.claudeBin });
```

with:

```js
  const claude = createClaude({
    bin: config.claudeBin,
    maxConcurrent: config.maxConcurrentRuns,
    minSpawnIntervalMs: config.claudeMinSpawnIntervalMs,
  });
```

**3b.** Add the run-level mutex after the existing project-keyed mutex:

```js
  const mutex = createKeyedMutex();
```

Add directly below:

```js
  const runLock = createKeyedMutex();
```

**3c.** Pass `runLock` to executor / prSweep / prReview:

Find:

```js
  const executor = createExecutor({
    db, gh, workspace, stages, decompose, config, git, preview,
  });
```

Replace with:

```js
  const executor = createExecutor({
    db, gh, workspace, stages, decompose, config, git, preview, runLock,
  });
```

Find:

```js
  const prSweep = createPrSweep({ db, gh, workspace, stages, config });
```

Replace with:

```js
  const prSweep = createPrSweep({ db, gh, workspace, stages, config, runLock });
```

Find:

```js
  const prReview = createPrReview({
    db, gh, workspace, stages, claude, config,
  });
```

Replace with:

```js
  const prReview = createPrReview({
    db, gh, workspace, stages, claude, config, runLock,
  });
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: ALL tests pass. The full suite is the only meaningful check here — wire.js is the integration point.

- [ ] **Step 5: Commit**

```bash
git add src/wire.js test/wire-cooldown.test.js
git commit -m "feat(wire): inject runLock + cooldown config into adapter, executor, prSweep, prReview"
```

---

## Task 11: Scenario S1 — operator labels a single issue (happy path)

**Files:**
- Test: `test/scenario-happy-path.test.js` (new)

This is the regression test that proves the throttles do not break healthy flow. Uses the existing `gh` and `git` fakes that other integration tests already use (`test/integration.test.js` is the prior art — read it for shape).

- [ ] **Step 1: Read the existing integration scaffolding**

```bash
node --test --reporter spec test/integration.test.js 2>&1 | head -40
sed -n '1,80p' test/integration.test.js
```

Reuse its fake-gh / fake-git / fake-claude builders. Do not duplicate them — import or copy the minimal subset.

- [ ] **Step 2: Write the test**

Create `test/scenario-happy-path.test.js`:

```js
// test/scenario-happy-path.test.js
// Operator labels a single issue → bot develops it → PR opens.
// Verifies the throttles (semaphore + pacing + cooldown) don't break the healthy path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createWorkspace } from "../src/workspace.js";
import { createExecutor } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import { createPoller } from "../src/poller.js";

function fakeClock(initialMs) {
  let t = initialMs;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

test("S1: single labeled issue → pr_open", async () => {
  const root = mkdtempSync(join(tmpdir(), "hc-s1-"));
  try {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main',?, 't')",
    ).run(root);

    let issueLabel = "claude-dev";
    const gh = {
      listLabeledIssues: async () => [{ number: 100, title: "feat", body: "go" }],
      swapLabel: async (_repo, _num, _from, to) => { issueLabel = to; },
      comment: async () => {},
      issue: async () => ({ number: 100, title: "feat", body: "go" }),
      prStatus: async () => ({ state: "OPEN", number: 1, mergeStateStatus: "CLEAN" }),
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
      openPr: async () => ({ url: "https://example/pr/1" }),
    };
    const git = () => ({ code: 0, stdout: "ok", stderr: "" });
    const claudeSpawns = [];
    const claude = { run: async (o) => { claudeSpawns.push(o.cwd); return { code: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false }; } };

    const config = {
      stageTimeoutMs: 1000, prReviewMaxIterations: 4,
      runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000, keepFailedWorktree: false,
    };
    const runLock = createKeyedMutex();
    const workspace = createWorkspace({ git, mutex: createKeyedMutex(), worktreesDir: root });
    const stages = {
      claude,
      runSpecPlan: async () => ({ size: "small" }),
      runImplement: async () => ({}),
      runReview: async () => ({ verdict: "approve" }),
      runPr: async () => ({ url: "https://example/pr/1" }),
      runResolveConflict: async () => {},
    };
    const executor = createExecutor({
      db, gh, workspace, stages, decompose: async () => {},
      config, git, preview: { maybeDeployPreview: async () => {} },
      runLock,
    });
    const scheduler = createScheduler({ db, executor, maxConcurrentRuns: 2 });
    const poller = createPoller({ db, gh, workspace });

    await poller.tick();
    await scheduler.drain();

    const run = db.prepare("SELECT * FROM runs WHERE issue_number=100").get();
    assert.ok(run, "run row must exist");
    assert.equal(run.state, "pr_open");
    assert.equal(run.consecutive_failures, 0);
    assert.ok(run.next_attempt_at, "successful run should be parked for next cooldown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test test/scenario-happy-path.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/scenario-happy-path.test.js
git commit -m "test(scenario): S1 — single labeled issue completes to pr_open"
```

---

## Task 12: Scenario S2 — five issues labeled at once, concurrency cap holds

**Files:**
- Test: `test/scenario-burst-labeling.test.js` (new)

- [ ] **Step 1: Write the test**

Create `test/scenario-burst-labeling.test.js`. The shape is identical to S1 but seeds 5 issues and tracks max concurrent claude:

```js
// test/scenario-burst-labeling.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { createClaude } from "../src/adapters/claude.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createWorkspace } from "../src/workspace.js";
import { createExecutor } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import { createPoller } from "../src/poller.js";

test("S2: 5 issues labeled at once → max 2 concurrent claude spawns at any instant", async () => {
  const root = mkdtempSync(join(tmpdir(), "hc-s2-"));
  try {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main',?, 't')",
    ).run(root);

    const issues = Array.from({ length: 5 }, (_, i) => ({ number: 200 + i, title: `feat${i}`, body: "go" }));
    let inFlight = 0, maxInFlight = 0;
    const fakeSpawn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { code: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false };
    };
    const claude = createClaude({
      bin: "fake", maxConcurrent: 2, minSpawnIntervalMs: 0, _spawn: fakeSpawn,
    });
    const gh = {
      listLabeledIssues: async () => issues,
      swapLabel: async () => {},
      comment: async () => {},
      issue: async (_repo, n) => issues.find((i) => i.number === n),
      prStatus: async () => ({ state: "OPEN", number: 1, mergeStateStatus: "CLEAN" }),
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
      openPr: async () => ({ url: "https://example/pr/1" }),
    };
    const git = () => ({ code: 0, stdout: "ok", stderr: "" });
    const config = {
      stageTimeoutMs: 1000, prReviewMaxIterations: 4,
      runCooldownMs: 0, runCooldownMaxMs: 0,           // disable cooldown to keep test fast
      keepFailedWorktree: false,
    };
    const stages = {
      claude,
      runSpecPlan: async () => { await claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 1000 }); return { size: "small" }; },
      runImplement: async () => { await claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 1000 }); },
      runReview: async () => { await claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 1000 }); return { verdict: "approve" }; },
      runPr: async () => { await claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 1000 }); return { url: "https://example/pr/1" }; },
      runResolveConflict: async () => {},
    };
    const workspace = createWorkspace({ git, mutex: createKeyedMutex(), worktreesDir: root });
    const executor = createExecutor({
      db, gh, workspace, stages, decompose: async () => {},
      config, git, preview: { maybeDeployPreview: async () => {} },
      runLock: createKeyedMutex(),
    });
    const scheduler = createScheduler({ db, executor, maxConcurrentRuns: 2 });
    const poller = createPoller({ db, gh, workspace });

    await poller.tick();
    await scheduler.drain();

    assert.equal(maxInFlight, 2, `expected concurrency cap 2, saw ${maxInFlight}`);
    const open = db.prepare("SELECT COUNT(*) as c FROM runs WHERE state='pr_open'").get().c;
    assert.equal(open, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/scenario-burst-labeling.test.js`
Expected: PASS — exactly 5 runs reach `pr_open`, max concurrent ≤2.

- [ ] **Step 3: Commit**

```bash
git add test/scenario-burst-labeling.test.js
git commit -m "test(scenario): S2 — concurrency semaphore holds at 2 across 5 burst-labeled issues"
```

---

## Task 13: Scenario S3 — regression test for 2026-05-20

**Files:**
- Test: `test/scenario-quota-exhausted.test.js` (new)

This is the most important test. It reproduces the incident: three stuck `pr_open` runs with conflicts, a `claude` that always exits 1, simulating 1 hour of interval firings. Without the fix, the spawn count was ~150+/hour. With the fix, it must be ≤25/hour.

- [ ] **Step 1: Write the test**

Create `test/scenario-quota-exhausted.test.js`:

```js
// test/scenario-quota-exhausted.test.js
// Regression for 2026-05-20: three pr_open runs that are DIRTY against main,
// claude always exits 1 (quota exhausted). Under the OLD behavior the
// prSweep + prReview intervals produced 150+ spawns/hour. Under the NEW
// behavior the per-run cooldown + global pacing cap it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createClaude } from "../src/adapters/claude.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrSweep } from "../src/prSweep.js";
import { createPrReview } from "../src/prReview.js";

function fakeClock(initialMs) {
  let t = initialMs;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

test("S3: 3 pr_open runs + claude exit 1 + 1h of intervals → bounded spawn count", async () => {
  const clock = fakeClock(new Date("2026-05-20T20:32:00Z").getTime());
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  for (const id of [20, 27, 51]) {
    db.prepare(
      "INSERT INTO runs(id,project_id,issue_number,state,worktree_path,branch,attempt,created_at,updated_at,needs_attention) VALUES(?,1,?,'pr_open',?,?,1,'t','t',0)",
    ).run(id, id + 5, `/tmp/wt-${id}`, `claude/${id + 5}-p`);
  }

  let spawnCount = 0;
  const fakeSpawn = async () => {
    spawnCount++;
    return { code: 1, stdout: "", stderr: "limit", timedOut: false, cancelled: false };
  };
  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 2,
    minSpawnIntervalMs: 180_000,
    now: clock.now,
    sleep: clock.sleep,
    _spawn: fakeSpawn,
  });

  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY", number: 99 }),
    prComments: async () => [],
    viewer: async () => "bot",
    prComment: async () => {},
    comment: async () => {},
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: true, files: ["a"] }),
    abortRebase: async () => {},
    pushBranch: async () => {},
    diffFingerprint: async () => "fp",
  };
  const stages = {
    claude,
    runResolveConflict: async (o) => { const r = await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 }); if (r.code !== 0) throw new Error("claude exited 1"); },
    runPrReview: async (o) => { const r = await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 }); if (r.code !== 0) throw new Error("claude exited 1"); return { verdict: "approve" }; },
    runPrFix: async () => ({ ok: true, summary: "" }),
  };
  const config = {
    stageTimeoutMs: 1000,
    prReviewMaxIterations: 4,
    runCooldownMs: 180_000,
    runCooldownMaxMs: 3_600_000,
    botLogin: "bot",
  };
  const runLock = createKeyedMutex();

  const prSweep = createPrSweep({ db, gh, workspace, stages, config, runLock, now: clock.now });
  const prReview = createPrReview({ db, gh, workspace, stages, claude, config, runLock, now: clock.now });

  // Simulate 1 hour with prSweep every 60s and prReview every 120s.
  const HOUR = 60 * 60 * 1000;
  for (let elapsed = 0; elapsed < HOUR; elapsed += 60_000) {
    await prSweep.tick();
    if (elapsed % 120_000 === 0) await prReview.tick();
    clock.advance(60_000);
  }

  // 1 hour of bursts at the OLD rate produced 150+ spawns. The new throttles cap it well below that.
  assert.ok(spawnCount <= 25, `expected ≤25 spawns/hour, got ${spawnCount}`);

  const rows = db.prepare("SELECT id, consecutive_failures FROM runs WHERE id IN (20,27,51)").all();
  for (const r of rows) {
    assert.ok(r.consecutive_failures >= 1, `run ${r.id} should have at least one recorded failure`);
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/scenario-quota-exhausted.test.js`
Expected: PASS — `spawnCount` is well under 25.

This test is the headline outcome of the change. If it fails, do not commit; check that prSweep/prReview are calling `recordFailure` and that the eligibility filter in their `tick()` is consulting `next_attempt_at`.

- [ ] **Step 3: Commit**

```bash
git add test/scenario-quota-exhausted.test.js
git commit -m "test(scenario): S3 — 2026-05-20 quota-exhausted regression bounds spawns to ≤25/hour"
```

---

## Task 14: Scenario S4 — `cdev retry` resets cooldown on a parked run

**Files:**
- Test: `test/scenario-retry-resets.test.js` (new)

- [ ] **Step 1: Find the retry endpoint to call**

```bash
grep -n "retry" src/api.js
```

The handler should be `POST /runs/:id/retry`. Note the exact response shape and what fields it touches on the new attempt row.

- [ ] **Step 2: Write the test**

Create `test/scenario-retry-resets.test.js`:

```js
// test/scenario-retry-resets.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { mountApi } from "../src/api.js";

test("S4: POST /runs/:id/retry creates a fresh attempt with cleared cooldown columns", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at,next_attempt_at,consecutive_failures) VALUES(51,1,62,'failed',1,'t','t','2099-01-01T00:00:00Z',19)",
  ).run();

  const app = express();
  app.use(express.json());
  mountApi(app, {
    db,
    projects: {},
    poller: { tick: async () => {} },
    scheduler: { tick: async () => {} },
    executor: { execute: async () => {}, cancel: () => {} },
  });

  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/runs/51/retry`, { method: "POST" });
    assert.equal(res.status, 200);

    const fresh = db
      .prepare("SELECT * FROM runs WHERE issue_number=62 AND attempt=2")
      .get();
    assert.ok(fresh, "retry should create attempt=2");
    assert.equal(fresh.state, "queued");
    assert.equal(fresh.consecutive_failures, 0);
    assert.equal(fresh.next_attempt_at, null);
  } finally {
    server.close();
  }
});
```

Engineer note: depending on the existing API mount, the retry endpoint may require auth. If `mountApi` uses bearer-token auth, pass `Authorization: Bearer ...` or read what the test scaffolding in `test/api.test.js` does for unauth'd setups. (Looking at server.js, `/` and `/healthz` are unauthenticated, others require the token — but `mountApi` itself may or may not enforce it. Mirror the existing `test/api.test.js`.)

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test test/scenario-retry-resets.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/scenario-retry-resets.test.js
git commit -m "test(scenario): S4 — cdev retry creates fresh attempt with cleared cooldown"
```

---

## Task 15: Scenario S5 — cooldown survives a restart

**Files:**
- Test: `test/scenario-restart-persists.test.js` (new)

- [ ] **Step 1: Write the test**

Create `test/scenario-restart-persists.test.js`:

```js
// test/scenario-restart-persists.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { recordFailure } from "../src/runCooldown.js";

test("S5: cooldown columns persist across a DB reopen (service restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-s5-"));
  const dbPath = join(dir, "auto.db");
  try {
    let db = openDb(dbPath);
    db.prepare(
      "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
    ).run();
    db.prepare(
      "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(7,1,42,'pr_open',1,'t','t')",
    ).run();
    const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
    const now = 1_700_000_000_000;
    recordFailure(db, 7, cfg, now);
    recordFailure(db, 7, cfg, now);
    recordFailure(db, 7, cfg, now);
    const before = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
    db.close();

    db = openDb(dbPath);
    const after = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
    assert.deepEqual(after, before);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test test/scenario-restart-persists.test.js`
Expected: PASS.

- [ ] **Step 3: Final whole-suite run**

```bash
PATH="/home/talhabera/.local/bin:$PATH" npm test
```

Expected: 100% pass. Note the `PATH=` prefix — `better-sqlite3` is pinned to the service's Node ABI; running tests under a different Node would trigger a rebuild that would crash the service on next restart.

- [ ] **Step 4: Commit and finish**

```bash
git add test/scenario-restart-persists.test.js
git commit -m "test(scenario): S5 — cooldown columns persist across service restart"
```

- [ ] **Step 5: Operator deploy**

```bash
PATH="/home/talhabera/.local/bin:$PATH" npm rebuild better-sqlite3   # belt-and-suspenders for the ABI pin
systemctl --user restart headless-claude.service
journalctl --user -u headless-claude.service -n 5 --no-pager        # verify the new "autonomous-dev wired:" line
```

Expected new startup log line includes `runCooldownMs=180000 minSpawnIntervalMs=180000` (extend the log in `server.js` if you want this visible; otherwise verify via `cdev runs` that the columns are present).

---

## Coverage check (against spec)

| Spec section | Tasks |
|---|---|
| Goal 1: global concurrency cap | T4 |
| Goal 2: one claude per issue at a time | T7 / T8 / T9 (run lock at each call site) |
| Goal 3: no overlapping ticks | T7, T8 (re-entrancy guard) |
| Goal 4: per-run cooldown | T3 (helper), T7/T8/T9 (call sites) |
| Goal 5: global spawn pacing | T4 + T5 |
| Goal "preserve healthy path" | S1 (T11), S2 (T12) |
| Spec section 1 (semaphore) | T4 |
| Spec section 2 (run lock) | T10 (instantiated in wire) + T7/T8/T9 (used at call sites) |
| Spec section 3 (tick re-entrancy) | T7, T8 |
| Spec section 4 (per-run cooldown DB) | T2 + T3 |
| Spec section 5 (global pacing) | T5 |
| Config table | T1 |
| DB migration | T2 |
| Scenario S1 | T11 |
| Scenario S2 | T12 |
| Scenario S3 (regression) | T13 |
| Scenario S4 | T14 |
| Scenario S5 | T15 |

All spec requirements covered.
