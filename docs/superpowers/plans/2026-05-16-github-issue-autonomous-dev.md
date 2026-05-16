# GitHub-Issue-Driven Autonomous Development — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless subsystem to `headless-claude` that watches labeled GitHub issues, develops each on an isolated git worktree through a gated `claude -p` pipeline, opens a PR, and keeps PRs rebased — without touching the existing tmux pool.

**Architecture:** A SQLite store is the source of truth. A poller enqueues labeled issues as runs; a global-semaphore scheduler drives a run executor through a `spec_plan → implement → review → pr` state machine with four enforced gates; oversized issues decompose into dependency-ordered sub-issues; auto-rebase keeps in-flight runs and open PRs current. `gh` and `claude -p` sit behind injectable adapters so every unit is tested without network or model calls.

**Tech Stack:** Node 20 (ESM), Express 5 (existing app, extended), `better-sqlite3`, `node:test` test runner, `git`/`gh`/`claude` CLIs behind adapters.

---

## Conventions (read first)

- **Test runner:** `node --test`. Test files: `test/<name>.test.js`. Use `node:test` + `node:assert/strict`.
- **DB in tests:** `openDb(':memory:')` — never touches disk.
- **Dependency injection:** every component is a `createX({...deps})` factory. Tests pass fake `gh`/`claude`/`git` objects. No module-level singletons except `config`.
- **Machine-readable stage output:** stages instruct `claude` to print a result block delimited by `<<<RESULT` and `RESULT>>>` containing JSON. Parsers only read that block, so they are testable with canned strings.
- **Commit after every task.** Conventional commit messages.

## File Structure

| File | Responsibility |
|---|---|
| `src/config.js` | Env config with defaults |
| `src/db.js` | Open `better-sqlite3`, run migrations (schema from spec) |
| `src/mutex.js` | Keyed async mutex (`runExclusive(key, fn)`) |
| `src/state.js` | State→label map; `transition()` writes `runs.state` + `run_logs` |
| `src/adapters/gh.js` | `gh` CLI adapter (issues, labels, comments, PRs, sub-issues) |
| `src/adapters/claude.js` | `claude -p` adapter (run prompt in cwd with timeout) |
| `src/adapters/git.js` | Thin `git` runner (`git(cwd, args)` → {code,stdout,stderr}) |
| `src/projects.js` | Project registry: register (clone), list, remove |
| `src/workspace.js` | Worktree create/teardown, fetch/ff, rebase, orphan sweep |
| `src/stages/specPlan.js` | spec+plan prompt + parse {size, spec, plan, checklist, depDAG} |
| `src/stages/implement.js` | TDD prompt + green-gate detection |
| `src/stages/review.js` | reviewer prompt + verdict parse |
| `src/stages/pr.js` | PR body builder + `gh pr create` |
| `src/decompose.js` | Cycle-check DAG, create sub-issues + `issue_deps` |
| `src/executor.js` | Run state machine driver |
| `src/scheduler.js` | Global semaphore, FIFO pick, launches executor |
| `src/poller.js` | Scan issues, enqueue/claim, unblock, merged detection |
| `src/prSweep.js` | Rebase system-owned open PRs behind base |
| `src/api.js` | Express routes mounted on existing app |
| `server.js` | **Modify:** wire DB + intervals + API into existing app |
| `cdev` | CLI mirroring `cspawn` |

---

## Phase 0: Project setup

### Task 0: Dependencies & test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add dependency and test script**

Edit `package.json` to:

```json
{
  "name": "headless-claude",
  "version": "1.0.0",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^5.2.1",
    "better-sqlite3": "^11.3.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `better-sqlite3` builds and appears in `node_modules`.

- [ ] **Step 3: Verify it loads**

Run: `node -e "import('better-sqlite3').then(m=>console.log(typeof m.default))"`
Expected: `function`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 and test script"
```

---

## Phase 1: Store, registry, workspace

### Task 1: Config

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("defaults apply when env unset", () => {
  const c = loadConfig({});
  assert.equal(c.maxConcurrentRuns, 2);
  assert.equal(c.issuePollMs, 30000);
  assert.equal(c.prSyncMs, 60000);
  assert.equal(c.stageTimeoutMs, 1800000);
  assert.equal(c.keepFailedWorktree, false);
  assert.ok(c.dbPath.endsWith("autonomous.db"));
});

test("env overrides parse correctly", () => {
  const c = loadConfig({
    MAX_CONCURRENT_RUNS: "5",
    KEEP_FAILED_WORKTREE: "true",
    PROJECTS_DIR: "/tmp/p",
  });
  assert.equal(c.maxConcurrentRuns, 5);
  assert.equal(c.keepFailedWorktree, true);
  assert.equal(c.projectsDir, "/tmp/p");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — cannot find `../src/config.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/config.js
import { join } from "node:path";

const num = (v, d) => (v === undefined ? d : parseInt(v, 10));
const bool = (v, d) => (v === undefined ? d : v === "true");

export function loadConfig(env = process.env) {
  const home = env.HOME || "/home/talhabera";
  const root = env.AUTONOMOUS_DIR || join(home, "claude-projects", "autonomous");
  return {
    projectsDir: env.PROJECTS_DIR || join(root, "projects"),
    worktreesDir: env.WORKTREES_DIR || join(root, "worktrees"),
    dbPath: env.DB_PATH || join(root, "autonomous.db"),
    issuePollMs: num(env.ISSUE_POLL_MS, 30000),
    prSyncMs: num(env.PR_SYNC_MS, 60000),
    maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 2),
    stageTimeoutMs: num(env.STAGE_TIMEOUT_MS, 1800000),
    keepFailedWorktree: bool(env.KEEP_FAILED_WORKTREE, false),
    ghBin: env.GH_BIN || "gh",
    claudeBin: env.CLAUDE_BIN || "/home/talhabera/.local/bin/claude",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: config loader with env defaults"
```

### Task 2: DB schema + migrations

**Files:**
- Create: `src/db.js`
- Test: `test/db.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/db.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";

test("openDb creates all tables", () => {
  const db = openDb(":memory:");
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(names, [
    "issue_deps",
    "projects",
    "run_artifacts",
    "run_logs",
    "runs",
  ]);
});

test("runs unique constraint on (project_id, issue_number, attempt)", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  const ins = db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,7,'queued',1,'t','t')",
  );
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — cannot find `../src/db.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/db.js
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE, repo TEXT, local_path TEXT,
  watch_label TEXT, base_branch TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, project_id INTEGER, issue_number INTEGER,
  parent_run_id INTEGER, state TEXT, worktree_path TEXT, branch TEXT,
  pr_url TEXT, attempt INTEGER DEFAULT 1, fail_reason TEXT,
  last_synced_base_sha TEXT, needs_attention INTEGER DEFAULT 0,
  attention_reason TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(project_id, issue_number, attempt));
CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY, run_id INTEGER, stage TEXT, level TEXT,
  message TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id INTEGER, kind TEXT, content TEXT,
  PRIMARY KEY (run_id, kind));
CREATE TABLE IF NOT EXISTS issue_deps (
  project_id INTEGER, issue_number INTEGER, depends_on_issue_number INTEGER,
  PRIMARY KEY (project_id, issue_number, depends_on_issue_number));
`;

export function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat: sqlite store with schema and migrations"
```

### Task 3: Keyed async mutex

**Files:**
- Create: `src/mutex.js`
- Test: `test/mutex.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/mutex.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../src/mutex.js";

test("same key serializes; different keys run concurrently", async () => {
  const m = createKeyedMutex();
  const order = [];
  const slow = (tag, ms) =>
    m.runExclusive("A", async () => {
      order.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-end`);
    });
  const p1 = slow("x", 30);
  const p2 = slow("y", 1);
  let bRan = false;
  const p3 = m.runExclusive("B", async () => {
    bRan = true;
  });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ["x-start", "x-end", "y-start", "y-end"]);
  assert.equal(bRan, true);
});

test("rejection releases the lock", async () => {
  const m = createKeyedMutex();
  await assert.rejects(
    m.runExclusive("K", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const v = await m.runExclusive("K", async () => 42);
  assert.equal(v, 42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mutex.test.js`
Expected: FAIL — cannot find `../src/mutex.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/mutex.js
export function createKeyedMutex() {
  const tails = new Map(); // key -> Promise chain tail
  function runExclusive(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    tails.set(key, prev.then(() => gate));
    const run = prev.then(() => fn());
    run.finally(() => {
      release();
      if (tails.get(key) && tails.get(key) !== prev) return;
    });
    return run;
  }
  return { runExclusive };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/mutex.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mutex.js test/mutex.test.js
git commit -m "feat: keyed async mutex"
```

### Task 4: State→label map and transition()

**Files:**
- Create: `src/state.js`
- Test: `test/state.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/state.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { LABEL_FOR, transition, TERMINAL } from "../src/state.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,5,'queued',1,'t','t')",
  ).run();
  return 1;
}

test("label mapping covers every state", () => {
  for (const s of [
    "queued", "blocked", "spec_plan", "implementing", "reviewing",
    "decomposing", "pr_open", "decomposed", "merged", "failed",
  ]) {
    assert.ok(LABEL_FOR[s], `missing label for ${s}`);
  }
  assert.equal(LABEL_FOR.queued, "in-progress");
  assert.equal(LABEL_FOR.pr_open, "pr-open");
});

test("transition updates state and writes a log row", () => {
  const db = openDb(":memory:");
  const id = seed(db);
  transition(db, id, "spec_plan", { stage: "spec_plan", message: "started" });
  const run = db.prepare("SELECT state FROM runs WHERE id=?").get(id);
  assert.equal(run.state, "spec_plan");
  const log = db
    .prepare("SELECT * FROM run_logs WHERE run_id=? ORDER BY id DESC")
    .get(id);
  assert.equal(log.message, "started");
  assert.equal(log.stage, "spec_plan");
});

test("TERMINAL set is correct", () => {
  assert.deepEqual(
    [...TERMINAL].sort(),
    ["decomposed", "failed", "merged", "pr_open"],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state.test.js`
Expected: FAIL — cannot find `../src/state.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/state.js
export const LABEL_FOR = {
  queued: "in-progress",
  blocked: "in-progress",
  spec_plan: "in-progress",
  implementing: "in-progress",
  reviewing: "in-progress",
  decomposing: "in-progress",
  pr_open: "pr-open",
  decomposed: "decomposed",
  merged: "merged",
  failed: "failed",
};

export const TERMINAL = new Set(["pr_open", "decomposed", "merged", "failed"]);

export function transition(db, runId, newState, log = {}) {
  const now = new Date().toISOString();
  db.prepare("UPDATE runs SET state=?, updated_at=? WHERE id=?").run(
    newState,
    now,
    runId,
  );
  db.prepare(
    "INSERT INTO run_logs (run_id,stage,level,message,ts) VALUES (?,?,?,?,?)",
  ).run(runId, log.stage || newState, log.level || "info", log.message || "", now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/state.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state.js test/state.test.js
git commit -m "feat: state-label map and transition helper"
```

### Task 5: git adapter

**Files:**
- Create: `src/adapters/git.js`
- Test: `test/git.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/git.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit } from "../src/adapters/git.js";

test("git runner returns code/stdout for a real repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitt-"));
  const git = createGit();
  assert.equal(git(dir, ["init", "-q"]).code, 0);
  const r = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "true");
});

test("non-zero exit is captured, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitt-"));
  const git = createGit();
  const r = git(dir, ["rev-parse", "HEAD"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a git repository|ambiguous argument/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — cannot find `../src/adapters/git.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/adapters/git.js
import { spawnSync } from "node:child_process";

export function createGit(bin = "git") {
  return function git(cwd, args, opts = {}) {
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      code: r.status === null ? 1 : r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || (r.error ? r.error.message : ""),
    };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/git.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/git.js test/git.test.js
git commit -m "feat: git CLI adapter"
```

### Task 6: gh adapter

**Files:**
- Create: `src/adapters/gh.js`
- Test: `test/gh.test.js`

The adapter shells out to `gh`; the test injects a fake `runner` so no network is touched. Production code uses the default real runner.

- [ ] **Step 1: Write the failing test**

```js
// test/gh.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGh } from "../src/adapters/gh.js";

function fakeRunner(script) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const key = args.join(" ");
    for (const [match, out] of script) {
      if (key.includes(match)) return { code: 0, stdout: out, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

test("listLabeledIssues parses gh json", async () => {
  const runner = fakeRunner([
    [
      "issue list",
      JSON.stringify([
        { number: 4, title: "A", body: "do A", state: "OPEN" },
      ]),
    ],
  ]);
  const gh = createGh({ runner });
  const issues = await gh.listLabeledIssues("o/r", "claude-dev");
  assert.equal(issues[0].number, 4);
  assert.match(runner.calls[0].join(" "), /issue list.*--label claude-dev/);
});

test("swapLabel removes then adds", async () => {
  const runner = fakeRunner([]);
  const gh = createGh({ runner });
  await gh.swapLabel("o/r", 4, "claude-dev", "in-progress");
  const joined = runner.calls.map((c) => c.join(" "));
  assert.ok(joined.some((c) => /--remove-label claude-dev/.test(c)));
  assert.ok(joined.some((c) => /--add-label in-progress/.test(c)));
});

test("createPR returns url from stdout", async () => {
  const runner = fakeRunner([["pr create", "https://github.com/o/r/pull/9\n"]]);
  const gh = createGh({ runner });
  const pr = await gh.createPR("o/r", {
    head: "claude/4-r",
    base: "main",
    title: "t",
    body: "b",
  });
  assert.equal(pr.url, "https://github.com/o/r/pull/9");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gh.test.js`
Expected: FAIL — cannot find `../src/adapters/gh.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/adapters/gh.js
import { spawnSync } from "node:child_process";

function defaultRunner(bin) {
  return (args) => {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      code: r.status === null ? 1 : r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || (r.error ? r.error.message : ""),
    };
  };
}

export function createGh({ bin = "gh", runner } = {}) {
  const run = runner || defaultRunner(bin);
  const ok = (r, what) => {
    if (r.code !== 0) throw new Error(`gh ${what} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  return {
    async listLabeledIssues(repo, label) {
      const out = ok(
        run([
          "issue", "list", "-R", repo, "--label", label, "--state", "open",
          "--json", "number,title,body,state", "--limit", "100",
        ]),
        "issue list",
      );
      return JSON.parse(out || "[]");
    },
    async issue(repo, number) {
      const out = ok(
        run([
          "issue", "view", String(number), "-R", repo,
          "--json", "number,title,body,state,closed",
        ]),
        "issue view",
      );
      return JSON.parse(out);
    },
    async swapLabel(repo, number, removeLabel, addLabel) {
      ok(
        run([
          "issue", "edit", String(number), "-R", repo,
          "--remove-label", removeLabel,
        ]),
        "remove label",
      );
      ok(
        run([
          "issue", "edit", String(number), "-R", repo,
          "--add-label", addLabel,
        ]),
        "add label",
      );
    },
    async setLabel(repo, number, addLabel) {
      ok(
        run(["issue", "edit", String(number), "-R", repo, "--add-label", addLabel]),
        "add label",
      );
    },
    async comment(repo, number, body) {
      ok(
        run(["issue", "comment", String(number), "-R", repo, "--body", body]),
        "comment",
      );
    },
    async createIssue(repo, { title, body }) {
      const out = ok(
        run(["issue", "create", "-R", repo, "--title", title, "--body", body]),
        "issue create",
      );
      const m = out.match(/\/issues\/(\d+)/);
      return { number: m ? Number(m[1]) : null, url: out.trim() };
    },
    async createPR(repo, { head, base, title, body }) {
      const out = ok(
        run([
          "pr", "create", "-R", repo, "--head", head, "--base", base,
          "--title", title, "--body", body,
        ]),
        "pr create",
      );
      return { url: out.trim() };
    },
    async prStatus(repo, head) {
      const out = ok(
        run([
          "pr", "view", head, "-R", repo,
          "--json", "state,mergeable,mergeStateStatus,number,url",
        ]),
        "pr view",
      );
      return JSON.parse(out);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/gh.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/gh.js test/gh.test.js
git commit -m "feat: gh CLI adapter with injectable runner"
```

### Task 7: claude adapter

**Files:**
- Create: `src/adapters/claude.js`
- Test: `test/claude.test.js`

- [ ] **Step 1: Write the failing test**

The adapter takes a `spawn` injection so the test uses a fake shell script (`node -e`) instead of real `claude`.

```js
// test/claude.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

test("run returns stdout and exit code", async () => {
  const claude = createClaude({
    bin: process.execPath,
    baseArgs: ["-e", "process.stdout.write('hello'); process.exit(0)"],
  });
  const r = await claude.run({ cwd: process.cwd(), prompt: "x", timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello/);
  assert.equal(r.timedOut, false);
});

test("timeout is reported", async () => {
  const claude = createClaude({
    bin: process.execPath,
    baseArgs: ["-e", "setTimeout(()=>{}, 10000)"],
  });
  const r = await claude.run({ cwd: process.cwd(), prompt: "x", timeoutMs: 200 });
  assert.equal(r.timedOut, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude.test.js`
Expected: FAIL — cannot find `../src/adapters/claude.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/adapters/claude.js
import { spawn } from "node:child_process";

export function createClaude({ bin, baseArgs } = {}) {
  const exe = bin || "/home/talhabera/.local/bin/claude";
  const args =
    baseArgs || ["-p", "--dangerously-skip-permissions", "--output-format", "text"];
  return {
    run({ cwd, prompt, timeoutMs }) {
      return new Promise((resolve) => {
        const child = spawn(exe, args, { cwd });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code === null ? 1 : code, stdout, stderr, timedOut });
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ code: 1, stdout, stderr: String(e), timedOut });
        });
        child.stdin.end(prompt);
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/claude.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude.js test/claude.test.js
git commit -m "feat: claude -p adapter with timeout"
```

### Task 8: Project registry

**Files:**
- Create: `src/projects.js`
- Test: `test/projects.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/projects.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createProjects } from "../src/projects.js";

function fakeGit(record) {
  return (cwd, args) => {
    record.push([cwd, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("register clones once and persists row", async () => {
  const db = openDb(":memory:");
  const calls = [];
  const projects = createProjects({
    db,
    git: fakeGit(calls),
    projectsDir: "/tmp/projects",
  });
  const p = await projects.register({
    repo: "octo/widget",
    watchLabel: "claude-dev",
    baseBranch: "next",
  });
  assert.equal(p.slug, "octo-widget");
  assert.equal(p.local_path, "/tmp/projects/octo-widget");
  assert.match(calls[0].join(" "), /clone .*octo\/widget .*octo-widget/);
  const row = db.prepare("SELECT * FROM projects WHERE slug='octo-widget'").get();
  assert.equal(row.base_branch, "next");
});

test("re-register same repo is rejected", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({
    db,
    git: fakeGit([]),
    projectsDir: "/tmp/projects",
  });
  await projects.register({ repo: "o/r", watchLabel: "l", baseBranch: "main" });
  await assert.rejects(
    projects.register({ repo: "o/r", watchLabel: "l", baseBranch: "main" }),
    /already registered/,
  );
});

test("list and remove", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({ db, git: fakeGit([]), projectsDir: "/tmp/p" });
  await projects.register({ repo: "o/a", watchLabel: "l", baseBranch: "main" });
  assert.equal(projects.list().length, 1);
  projects.remove("o-a");
  assert.equal(projects.list().length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/projects.test.js`
Expected: FAIL — cannot find `../src/projects.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/projects.js
import { join } from "node:path";

export function slugify(repo) {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createProjects({ db, git, projectsDir }) {
  return {
    async register({ repo, watchLabel, baseBranch }) {
      const slug = slugify(repo);
      const existing = db
        .prepare("SELECT 1 FROM projects WHERE slug=?")
        .get(slug);
      if (existing) throw new Error(`project ${repo} already registered`);
      const localPath = join(projectsDir, slug);
      const r = git(projectsDir, [
        "clone",
        `https://github.com/${repo}.git`,
        slug,
      ]);
      if (r.code !== 0) throw new Error(`clone failed: ${r.stderr.trim()}`);
      db.prepare(
        `INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        slug,
        repo,
        localPath,
        watchLabel,
        baseBranch,
        new Date().toISOString(),
      );
      return db.prepare("SELECT * FROM projects WHERE slug=?").get(slug);
    },
    list() {
      return db.prepare("SELECT * FROM projects ORDER BY id").all();
    },
    get(slug) {
      return db.prepare("SELECT * FROM projects WHERE slug=?").get(slug);
    },
    remove(slug) {
      db.prepare("DELETE FROM projects WHERE slug=?").run(slug);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/projects.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/projects.js test/projects.test.js
git commit -m "feat: project registry with clone-on-register"
```

### Task 9: Workspace manager

**Files:**
- Create: `src/workspace.js`
- Test: `test/workspace.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/workspace.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../src/mutex.js";
import { createWorkspace } from "../src/workspace.js";

function scriptedGit(map) {
  const calls = [];
  const git = (cwd, args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    for (const [m, res] of map) if (key.includes(m)) return res;
    return { code: 0, stdout: "", stderr: "" };
  };
  git.calls = calls;
  return git;
}

const project = {
  slug: "o-r",
  local_path: "/clones/o-r",
  base_branch: "main",
};

test("prepareClone fetches and fast-forwards base", async () => {
  const git = scriptedGit([]);
  const ws = createWorkspace({
    git,
    mutex: createKeyedMutex(),
    worktreesDir: "/wt",
  });
  await ws.prepareClone(project);
  assert.ok(git.calls.some((c) => /fetch origin/.test(c)));
  assert.ok(git.calls.some((c) => /checkout main/.test(c)));
  assert.ok(git.calls.some((c) => /reset --hard origin\/main/.test(c)));
});

test("addWorktree creates branch off base and returns path", async () => {
  const git = scriptedGit([]);
  const ws = createWorkspace({
    git,
    mutex: createKeyedMutex(),
    worktreesDir: "/wt",
  });
  const r = await ws.addWorktree(project, { issue_number: 7, attempt: 1 });
  assert.equal(r.branch, "claude/7-o-r");
  assert.equal(r.path, "/wt/o-r-7-1");
  assert.ok(
    git.calls.some((c) =>
      /worktree add \/wt\/o-r-7-1 -b claude\/7-o-r origin\/main/.test(c),
    ),
  );
});

test("rebaseOnBase reports conflict with files", async () => {
  const git = scriptedGit([
    ["rebase origin/main", { code: 1, stdout: "", stderr: "CONFLICT" }],
    [
      "diff --name-only --diff-filter=U",
      { code: 0, stdout: "a.js\nb.js\n", stderr: "" },
    ],
  ]);
  const ws = createWorkspace({
    git,
    mutex: createKeyedMutex(),
    worktreesDir: "/wt",
  });
  const r = await ws.rebaseOnBase(project, "/wt/o-r-7-1");
  assert.equal(r.conflicted, true);
  assert.deepEqual(r.files, ["a.js", "b.js"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/workspace.test.js`
Expected: FAIL — cannot find `../src/workspace.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/workspace.js
import { join } from "node:path";
import { rmSync } from "node:fs";

export function createWorkspace({ git, mutex, worktreesDir }) {
  const lock = (project, fn) => mutex.runExclusive(project.slug, fn);

  function headSha(project) {
    const r = git(project.local_path, ["rev-parse", `origin/${project.base_branch}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  return {
    headSha,
    prepareClone(project) {
      return lock(project, async () => {
        const lp = project.local_path;
        const b = project.base_branch;
        let r = git(lp, ["fetch", "origin", "--prune"]);
        if (r.code !== 0) throw new Error(`fetch failed: ${r.stderr.trim()}`);
        git(lp, ["checkout", b]);
        r = git(lp, ["reset", "--hard", `origin/${b}`]);
        if (r.code !== 0) throw new Error(`reset failed: ${r.stderr.trim()}`);
        return headSha(project);
      });
    },
    addWorktree(project, run) {
      return lock(project, async () => {
        const path = join(
          worktreesDir,
          `${project.slug}-${run.issue_number}-${run.attempt}`,
        );
        const branch = `claude/${run.issue_number}-${project.slug}`;
        const r = git(project.local_path, [
          "worktree", "add", path, "-b", branch,
          `origin/${project.base_branch}`,
        ]);
        if (r.code !== 0)
          throw new Error(`worktree add failed: ${r.stderr.trim()}`);
        return { path, branch };
      });
    },
    rebaseOnBase(project, worktreePath) {
      return lock(project, async () => {
        git(project.local_path, ["fetch", "origin", "--prune"]);
        const r = git(worktreePath, [
          "rebase",
          `origin/${project.base_branch}`,
        ]);
        if (r.code === 0) return { conflicted: false };
        const f = git(worktreePath, [
          "diff", "--name-only", "--diff-filter=U",
        ]);
        return {
          conflicted: true,
          files: f.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
        };
      });
    },
    abortRebase(project, worktreePath) {
      return lock(project, async () => {
        git(worktreePath, ["rebase", "--abort"]);
      });
    },
    pushBranch(project, worktreePath, branch) {
      return lock(project, async () => {
        const r = git(worktreePath, [
          "push", "--force-with-lease", "origin", branch,
        ]);
        if (r.code !== 0) throw new Error(`push failed: ${r.stderr.trim()}`);
      });
    },
    removeWorktree(project, path, { deleteBranch, branch } = {}) {
      return lock(project, async () => {
        git(project.local_path, ["worktree", "remove", "--force", path]);
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {}
        if (deleteBranch && branch)
          git(project.local_path, ["branch", "-D", branch]);
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/workspace.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workspace.js test/workspace.test.js
git commit -m "feat: workspace manager (worktree, fetch/ff, rebase) under per-project mutex"
```

---

## Phase 2: Poller, scheduler, executor, gates

### Task 10: Stage output parser (shared)

**Files:**
- Create: `src/stages/parse.js`
- Test: `test/parse.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/parse.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResultBlock } from "../src/stages/parse.js";

test("extracts JSON between markers", () => {
  const out = `chatter\n<<<RESULT\n{"size":"small","ok":true}\nRESULT>>>\nmore`;
  assert.deepEqual(parseResultBlock(out), { size: "small", ok: true });
});

test("throws when block missing", () => {
  assert.throws(() => parseResultBlock("no block here"), /no RESULT block/);
});

test("throws on invalid json", () => {
  assert.throws(
    () => parseResultBlock("<<<RESULT\n{bad}\nRESULT>>>"),
    /invalid RESULT json/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/parse.test.js`
Expected: FAIL — cannot find `../src/stages/parse.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/stages/parse.js
export function parseResultBlock(text) {
  const m = text.match(/<<<RESULT\s*([\s\S]*?)\s*RESULT>>>/);
  if (!m) throw new Error("no RESULT block in stage output");
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`invalid RESULT json: ${e.message}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/parse.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/parse.js test/parse.test.js
git commit -m "feat: shared RESULT-block parser"
```

### Task 11: spec+plan stage

**Files:**
- Create: `src/stages/specPlan.js`
- Test: `test/specPlan.test.js`

This stage builds the prompt, runs `claude`, parses `{size, depDAG, acceptanceChecklist}`, and persists `spec`/`plan`/`acceptance_checklist` artifacts. It does **not** branch the state machine — the executor does that from `result.size`.

- [ ] **Step 1: Write the failing test**

```js
// test/specPlan.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runSpecPlan } from "../src/stages/specPlan.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,3,'spec_plan',1,'t','t')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("small: persists artifacts and returns size=small", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0,
      timedOut: false,
      stdout: `<<<RESULT
{"size":"small","spec":"SPEC TEXT","plan":"PLAN TEXT",
"acceptanceChecklist":["does X","does Y"],"selfReviewPassed":true}
RESULT>>>`,
      stderr: "",
    }),
  };
  const r = await runSpecPlan({
    db, run, claude,
    issue: { number: 3, title: "T", body: "B" },
    cwd: "/wt", timeoutMs: 1000,
  });
  assert.equal(r.size, "small");
  const spec = db
    .prepare("SELECT content FROM run_artifacts WHERE run_id=1 AND kind='spec'")
    .get();
  assert.equal(spec.content, "SPEC TEXT");
  const cl = db
    .prepare(
      "SELECT content FROM run_artifacts WHERE run_id=1 AND kind='acceptance_checklist'",
    )
    .get();
  assert.deepEqual(JSON.parse(cl.content), ["does X", "does Y"]);
});

test("failed self-review throws gate error", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"size":"small","spec":"s","plan":"p","acceptanceChecklist":[],"selfReviewPassed":false}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runSpecPlan({
      db, run, claude,
      issue: { number: 3, title: "T", body: "B" },
      cwd: "/wt", timeoutMs: 1000,
    }),
    /spec_plan: self-review did not pass/,
  );
});

test("timeout throws", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({ code: 1, timedOut: true, stdout: "", stderr: "" }),
  };
  await assert.rejects(
    runSpecPlan({
      db, run, claude,
      issue: { number: 3, title: "T", body: "B" },
      cwd: "/wt", timeoutMs: 1,
    }),
    /spec_plan: timed out/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/specPlan.test.js`
Expected: FAIL — cannot find `../src/stages/specPlan.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/stages/specPlan.js
import { parseResultBlock } from "./parse.js";

function saveArtifact(db, runId, kind, content) {
  db.prepare(
    `INSERT INTO run_artifacts (run_id,kind,content) VALUES (?,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET content=excluded.content`,
  ).run(runId, kind, content);
}

export function buildSpecPlanPrompt(issue) {
  return `You are developing GitHub issue #${issue.number}: "${issue.title}".

Issue body:
${issue.body || "(empty)"}

Use the superpowers brainstorming + writing-plans approach to produce a spec
and a phased implementation plan for THIS repository (you are in its worktree).
Extract explicit acceptance criteria as a checklist. Then judge whether the
issue is small enough to implement as a single PR, or large enough that it
must be split into independent, dependency-ordered sub-issues.

Run a self-review of the spec+plan (placeholders, contradictions, ambiguity,
scope). If it does not pass, set selfReviewPassed=false.

If large, propose subIssues as a DAG: each item {key,title,body,dependsOn:[keys]}.

Output ONLY this block at the end:
<<<RESULT
{"size":"small|large","spec":"<spec markdown>","plan":"<plan markdown>",
"acceptanceChecklist":["..."],"selfReviewPassed":true|false,
"subIssues":[{"key":"a","title":"...","body":"...","dependsOn":[]}]}
RESULT>>>`;
}

export async function runSpecPlan({ db, run, claude, issue, cwd, timeoutMs }) {
  const res = await claude.run({
    cwd,
    prompt: buildSpecPlanPrompt(issue),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("spec_plan: timed out");
  if (res.code !== 0)
    throw new Error(`spec_plan: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.selfReviewPassed)
    throw new Error("spec_plan: self-review did not pass");
  saveArtifact(db, run.id, "spec", parsed.spec || "");
  saveArtifact(db, run.id, "plan", parsed.plan || "");
  saveArtifact(
    db,
    run.id,
    "acceptance_checklist",
    JSON.stringify(parsed.acceptanceChecklist || []),
  );
  return {
    size: parsed.size === "large" ? "large" : "small",
    subIssues: parsed.subIssues || [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/specPlan.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/specPlan.js test/specPlan.test.js
git commit -m "feat: spec+plan stage with self-review gate"
```

### Task 12: implement stage (TDD green-gate)

**Files:**
- Create: `src/stages/implement.js`
- Test: `test/implement.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/implement.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runImplement } from "../src/stages/implement.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,3,'implementing',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO run_artifacts (run_id,kind,content) VALUES (1,'plan','PLAN')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("green gate passes when claude reports allGreen", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"allGreen":true,"summary":"implemented per plan"}
RESULT>>>`,
    }),
  };
  const r = await runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.allGreen, true);
});

test("gate fails when not green", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"allGreen":false,"summary":"3 failing tests"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 }),
    /implement: gate not green: 3 failing tests/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/implement.test.js`
Expected: FAIL — cannot find `../src/stages/implement.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/stages/implement.js
import { parseResultBlock } from "./parse.js";

export function buildImplementPrompt(plan) {
  return `Implement the plan below in this worktree using strict TDD
(superpowers test-driven-development): write failing tests first, minimal
code, refactor. Detect the project's own test/lint/typecheck commands and
run them. Do NOT finish until tests, lint, and typecheck are all green.
Commit frequently.

PLAN:
${plan}

Output ONLY this block at the end:
<<<RESULT
{"allGreen":true|false,"summary":"<what you did / why not green>"}
RESULT>>>`;
}

export async function runImplement({ db, run, claude, cwd, timeoutMs }) {
  const plan =
    db
      .prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='plan'")
      .get(run.id)?.content || "";
  const res = await claude.run({
    cwd,
    prompt: buildImplementPrompt(plan),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("implement: timed out");
  if (res.code !== 0)
    throw new Error(`implement: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.allGreen)
    throw new Error(`implement: gate not green: ${parsed.summary || "unknown"}`);
  return { allGreen: true, summary: parsed.summary || "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/implement.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/implement.js test/implement.test.js
git commit -m "feat: implement stage with TDD green-gate"
```

### Task 13: review stage

**Files:**
- Create: `src/stages/review.js`
- Test: `test/review.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/review.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runReview } from "../src/stages/review.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,3,'reviewing',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO run_artifacts (run_id,kind,content) VALUES (1,'spec','SPEC'),(1,'acceptance_checklist','[\"X\"]')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("approve returns verdict approve and stores it", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"verdict":"approve","checklist":[{"item":"X","met":true}],"notes":"lgtm"}
RESULT>>>`,
    }),
  };
  const r = await runReview({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.verdict, "approve");
  const a = db
    .prepare("SELECT content FROM run_artifacts WHERE run_id=1 AND kind='review_verdict'")
    .get();
  assert.match(a.content, /approve/);
});

test("changes-requested returned (executor decides looping)", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"verdict":"changes-requested","checklist":[{"item":"X","met":false}],"notes":"fix X"}
RESULT>>>`,
    }),
  };
  const r = await runReview({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.verdict, "changes-requested");
  assert.equal(r.notes, "fix X");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review.test.js`
Expected: FAIL — cannot find `../src/stages/review.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/stages/review.js
import { parseResultBlock } from "./parse.js";

export function buildReviewPrompt(spec, checklist) {
  return `You are an independent reviewer. Review the committed diff in this
worktree against the spec and the acceptance checklist. Use superpowers
requesting-code-review rigor. Verify each checklist item is actually met by
the code (not just claimed).

SPEC:
${spec}

ACCEPTANCE CHECKLIST: ${checklist}

Output ONLY this block:
<<<RESULT
{"verdict":"approve|changes-requested",
"checklist":[{"item":"...","met":true|false}],"notes":"<actionable>"}
RESULT>>>`;
}

export async function runReview({ db, run, claude, cwd, timeoutMs }) {
  const spec =
    db.prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='spec'").get(run.id)
      ?.content || "";
  const checklist =
    db
      .prepare(
        "SELECT content FROM run_artifacts WHERE run_id=? AND kind='acceptance_checklist'",
      )
      .get(run.id)?.content || "[]";
  const res = await claude.run({
    cwd,
    prompt: buildReviewPrompt(spec, checklist),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("review: timed out");
  if (res.code !== 0)
    throw new Error(`review: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  db.prepare(
    `INSERT INTO run_artifacts (run_id,kind,content) VALUES (?,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET content=excluded.content`,
  ).run(run.id, "review_verdict", JSON.stringify(parsed));
  return {
    verdict: parsed.verdict === "approve" ? "approve" : "changes-requested",
    notes: parsed.notes || "",
    checklist: parsed.checklist || [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/review.js test/review.test.js
git commit -m "feat: independent review stage"
```

### Task 14: PR stage

**Files:**
- Create: `src/stages/pr.js`
- Test: `test/pr.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/pr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { buildPrBody, runPr } from "../src/stages/pr.js";

test("buildPrBody renders checklist + closes", () => {
  const body = buildPrBody({
    issueNumber: 8,
    specExcerpt: "Build X",
    checklist: ["does A", "does B"],
  });
  assert.match(body, /Closes #8/);
  assert.match(body, /- \[x\] does A/);
  assert.match(body, /- \[x\] does B/);
});

test("runPr creates PR via gh and stores url", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,attempt,created_at,updated_at) VALUES (1,8,'reviewing','claude/8-o-r',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO run_artifacts (run_id,kind,content) VALUES (1,'spec','Build X'),(1,'acceptance_checklist','[\"does A\"]')",
  ).run();
  const run = db.prepare("SELECT * FROM runs WHERE id=1").get();
  const project = db.prepare("SELECT * FROM projects WHERE id=1").get();
  const gh = {
    createPR: async (repo, opts) => {
      assert.equal(opts.base, "main");
      assert.equal(opts.head, "claude/8-o-r");
      assert.match(opts.body, /Closes #8/);
      return { url: "https://github.com/o/r/pull/12" };
    },
  };
  const r = await runPr({ db, run, project, gh, issue: { title: "T" } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  const stored = db.prepare("SELECT pr_url FROM runs WHERE id=1").get();
  assert.equal(stored.pr_url, "https://github.com/o/r/pull/12");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pr.test.js`
Expected: FAIL — cannot find `../src/stages/pr.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/stages/pr.js
export function buildPrBody({ issueNumber, specExcerpt, checklist }) {
  const items = checklist.map((c) => `- [x] ${c}`).join("\n");
  return `## Summary

${specExcerpt}

## Acceptance criteria

${items}

Closes #${issueNumber}

---
*Opened automatically by headless-claude autonomous dev.*`;
}

export async function runPr({ db, run, project, gh, issue }) {
  const spec =
    db.prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='spec'").get(run.id)
      ?.content || "";
  const checklist = JSON.parse(
    db
      .prepare(
        "SELECT content FROM run_artifacts WHERE run_id=? AND kind='acceptance_checklist'",
      )
      .get(run.id)?.content || "[]",
  );
  const body = buildPrBody({
    issueNumber: run.issue_number,
    specExcerpt: spec.slice(0, 600),
    checklist,
  });
  const pr = await gh.createPR(project.repo, {
    head: run.branch,
    base: project.base_branch,
    title: `${issue.title} (closes #${run.issue_number})`,
    body,
  });
  db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run(pr.url, run.id);
  return { prUrl: pr.url };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pr.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/pr.js test/pr.test.js
git commit -m "feat: PR stage with acceptance-checklist body"
```

### Task 15: Executor state machine (small-issue happy path + review loop + failure)

**Files:**
- Create: `src/executor.js`
- Test: `test/executor.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/executor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";

function base(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/clones/o-r','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  return {
    run: db.prepare("SELECT * FROM runs WHERE id=1").get(),
    project: db.prepare("SELECT * FROM projects WHERE id=1").get(),
  };
}

const ws = {
  prepareClone: async () => "sha0",
  addWorktree: async () => ({ path: "/wt/o-r-8-1", branch: "claude/8-o-r" }),
  removeWorktree: async () => {},
  rebaseOnBase: async () => ({ conflicted: false }),
};
const gh = {
  issue: async () => ({ number: 8, title: "T", body: "B", state: "OPEN" }),
  comment: async () => {},
  swapLabel: async () => {},
  setLabel: async () => {},
  createPR: async () => ({ url: "https://github.com/o/r/pull/1" }),
};

test("small issue: queued → pr_open", async () => {
  const db = openDb(":memory:");
  const { run, project } = base(db);
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve", notes: "", checklist: [] }),
    runPr: async ({ db, run }) => {
      db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run("u", run.id);
      return { prUrl: "u" };
    },
  };
  const ex = createExecutor({ db, gh, workspace: ws, stages, decompose: async () => {}, config: { stageTimeoutMs: 10 } });
  await ex.execute(run.id);
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");
});

test("review changes-requested loops once then fails on 2nd", async () => {
  const db = openDb(":memory:");
  const { run } = base(db);
  let reviews = 0;
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => {
      reviews++;
      return { verdict: "changes-requested", notes: "no", checklist: [] };
    },
    runPr: async () => ({ prUrl: "u" }),
  };
  const ex = createExecutor({ db, gh, workspace: ws, stages, decompose: async () => {}, config: { stageTimeoutMs: 10 } });
  await ex.execute(run.id);
  assert.equal(reviews, 2);
  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /review/);
});

test("stage throw → failed + issue comment", async () => {
  const db = openDb(":memory:");
  const { run } = base(db);
  let commented = false;
  const gh2 = { ...gh, comment: async () => { commented = true; } };
  const stages = {
    runSpecPlan: async () => {
      throw new Error("spec_plan: timed out");
    },
  };
  const ex = createExecutor({ db, gh: gh2, workspace: ws, stages, decompose: async () => {}, config: { stageTimeoutMs: 10 } });
  await ex.execute(run.id);
  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /spec_plan: timed out/);
  assert.equal(commented, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/executor.test.js`
Expected: FAIL — cannot find `../src/executor.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/executor.js
import { transition, LABEL_FOR } from "./state.js";

export function createExecutor({ db, gh, workspace, stages, decompose, config }) {
  const getRun = (id) => db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  const getProject = (pid) =>
    db.prepare("SELECT * FROM projects WHERE id=?").get(pid);

  async function fail(run, project, reason) {
    db.prepare("UPDATE runs SET fail_reason=? WHERE id=?").run(reason, run.id);
    transition(db, run.id, "failed", { stage: "executor", level: "error", message: reason });
    try {
      await gh.swapLabel(
        project.repo,
        run.issue_number,
        LABEL_FOR[run.state] || project.watch_label,
        "failed",
      );
    } catch {}
    try {
      await gh.comment(
        project.repo,
        run.issue_number,
        `Autonomous run failed: ${reason}`,
      );
    } catch {}
    if (run.worktree_path && !config.keepFailedWorktree) {
      try {
        await workspace.removeWorktree(project, run.worktree_path, {});
      } catch {}
    }
  }

  async function execute(runId) {
    let run = getRun(runId);
    const project = getProject(run.project_id);
    try {
      const issue = await gh.issue(project.repo, run.issue_number);

      const baseSha = await workspace.prepareClone(project);
      const wt = await workspace.addWorktree(project, run);
      db.prepare(
        "UPDATE runs SET worktree_path=?, branch=?, last_synced_base_sha=? WHERE id=?",
      ).run(wt.path, wt.branch, baseSha, run.id);
      run = getRun(runId);

      transition(db, run.id, "spec_plan", { stage: "spec_plan", message: "start" });
      const sp = await stages.runSpecPlan({
        db, run, claude: stages.claude, issue,
        cwd: wt.path, timeoutMs: config.stageTimeoutMs,
      });

      if (sp.size === "large") {
        transition(db, run.id, "decomposing", { stage: "decomposing", message: "splitting" });
        await decompose({ db, gh, project, parentRun: run, subIssues: sp.subIssues });
        transition(db, run.id, "decomposed", { stage: "decomposing", message: "done" });
        try {
          await gh.swapLabel(project.repo, run.issue_number, "in-progress", "decomposed");
        } catch {}
        await workspace.removeWorktree(project, wt.path, {});
        return;
      }

      let attempts = 0;
      while (true) {
        transition(db, run.id, "implementing", { stage: "implement", message: "start" });
        await workspace.rebaseOnBase(project, wt.path); // sync checkpoint
        await stages.runImplement({
          db, run, claude: stages.claude, cwd: wt.path,
          timeoutMs: config.stageTimeoutMs,
        });

        transition(db, run.id, "reviewing", { stage: "review", message: "start" });
        await workspace.rebaseOnBase(project, wt.path); // sync checkpoint
        const rv = await stages.runReview({
          db, run, claude: stages.claude, cwd: wt.path,
          timeoutMs: config.stageTimeoutMs,
        });
        if (rv.verdict === "approve") break;
        attempts++;
        if (attempts >= 2) {
          await fail(run, project, `review: changes still requested after retry (${rv.notes})`);
          return;
        }
      }

      const pr = await stages.runPr({
        db, run: getRun(runId), project,
        gh, issue,
      });
      transition(db, run.id, "pr_open", { stage: "pr", message: pr.prUrl });
      try {
        await gh.swapLabel(project.repo, run.issue_number, "in-progress", "pr-open");
      } catch {}
      await workspace.removeWorktree(project, wt.path, {});
    } catch (e) {
      await fail(getRun(runId), getProject(getRun(runId).project_id), e.message);
    }
  }

  return { execute };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/executor.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/executor.js test/executor.test.js
git commit -m "feat: run executor state machine (spec_plan→pr, review loop, failure)"
```

### Task 16: Scheduler (global semaphore, FIFO)

**Files:**
- Create: `src/scheduler.js`
- Test: `test/scheduler.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/scheduler.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createScheduler } from "../src/scheduler.js";

function seedRuns(db, n) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  for (let i = 1; i <= n; i++)
    db.prepare(
      "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,?, 'queued',1,'t','t')",
    ).run(i);
}

test("never exceeds maxConcurrentRuns; skips blocked", async () => {
  const db = openDb(":memory:");
  seedRuns(db, 5);
  db.prepare("UPDATE runs SET state='blocked' WHERE issue_number=3").run();
  let active = 0;
  let peak = 0;
  const executor = {
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    },
  };
  const sched = createScheduler({ db, executor, maxConcurrentRuns: 2 });
  await sched.drain();
  assert.equal(peak, 2);
  // blocked one never executed → still blocked
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=3").get().state,
    "blocked",
  );
});

test("FIFO order by run id", async () => {
  const db = openDb(":memory:");
  seedRuns(db, 3);
  const order = [];
  const executor = {
    execute: async (id) => {
      order.push(id);
    },
  };
  const sched = createScheduler({ db, executor, maxConcurrentRuns: 1 });
  await sched.drain();
  assert.deepEqual(order, [1, 2, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler.test.js`
Expected: FAIL — cannot find `../src/scheduler.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/scheduler.js
export function createScheduler({ db, executor, maxConcurrentRuns }) {
  const inFlight = new Set();

  function claimNext() {
    const row = db
      .prepare(
        `SELECT id FROM runs WHERE state='queued' AND id NOT IN (${
          [...inFlight].map(() => "?").join(",") || "0"
        }) ORDER BY id LIMIT 1`,
      )
      .get(...inFlight);
    return row ? row.id : null;
  }

  async function tick() {
    const launched = [];
    while (inFlight.size < maxConcurrentRuns) {
      const id = claimNext();
      if (id == null) break;
      inFlight.add(id);
      const p = Promise.resolve(executor.execute(id)).finally(() =>
        inFlight.delete(id),
      );
      launched.push(p);
    }
    return launched;
  }

  async function drain() {
    let all = [];
    // loop until no queued runs remain and nothing is in flight
    while (true) {
      const launched = await tick();
      all = all.concat(launched);
      if (launched.length === 0) {
        if (inFlight.size === 0) break;
        await Promise.race([...all]);
      }
    }
    await Promise.all(all);
  }

  return { tick, drain, inFlight };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.js test/scheduler.test.js
git commit -m "feat: global-semaphore FIFO scheduler"
```

### Task 17: Poller (enqueue/claim, blocked insert, unblock, merged)

**Files:**
- Create: `src/poller.js`
- Test: `test/poller.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/poller.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createPoller } from "../src/poller.js";

function project(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','claude-dev','main','t')",
  ).run();
  return db.prepare("SELECT * FROM projects WHERE id=1").get();
}

test("new labeled issue → queued run + label swapped", async () => {
  const db = openDb(":memory:");
  project(db);
  let swapped = null;
  const gh = {
    listLabeledIssues: async () => [{ number: 5, title: "A", body: "" }],
    swapLabel: async (_r, n, from, to) => (swapped = [n, from, to]),
    issue: async () => ({ state: "OPEN" }),
  };
  const poller = createPoller({ db, gh });
  await poller.tick();
  const run = db.prepare("SELECT * FROM runs WHERE issue_number=5").get();
  assert.equal(run.state, "queued");
  assert.deepEqual(swapped, [5, "claude-dev", "in-progress"]);
});

test("issue with unmet deps → blocked", async () => {
  const db = openDb(":memory:");
  project(db);
  db.prepare(
    "INSERT INTO issue_deps (project_id,issue_number,depends_on_issue_number) VALUES (1,9,8)",
  ).run();
  const gh = {
    listLabeledIssues: async () => [{ number: 9, title: "B", body: "" }],
    swapLabel: async () => {},
    issue: async (_r, n) => ({ state: n === 8 ? "OPEN" : "OPEN" }),
  };
  const poller = createPoller({ db, gh });
  await poller.tick();
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=9").get().state,
    "blocked",
  );
});

test("blocker closed → dependent blocked→queued", async () => {
  const db = openDb(":memory:");
  project(db);
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,9,'blocked',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO issue_deps (project_id,issue_number,depends_on_issue_number) VALUES (1,9,8)",
  ).run();
  const gh = {
    listLabeledIssues: async () => [],
    swapLabel: async () => {},
    issue: async (_r, n) => ({ state: n === 8 ? "CLOSED" : "OPEN", closed: n === 8 }),
  };
  const poller = createPoller({ db, gh });
  await poller.tick();
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=9").get().state,
    "queued",
  );
});

test("pr_open run whose issue closed → merged", async () => {
  const db = openDb(":memory:");
  project(db);
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,attempt,created_at,updated_at) VALUES (1,4,'pr_open','claude/4-o-r',1,'t','t')",
  ).run();
  const gh = {
    listLabeledIssues: async () => [],
    swapLabel: async () => {},
    issue: async () => ({ state: "CLOSED", closed: true }),
  };
  const removed = [];
  const workspace = { removeWorktree: async (_p, path) => removed.push(path) };
  const poller = createPoller({ db, gh, workspace });
  await poller.tick();
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=4").get().state,
    "merged",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/poller.test.js`
Expected: FAIL — cannot find `../src/poller.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/poller.js
import { transition } from "./state.js";

export function createPoller({ db, gh, workspace }) {
  const projects = () => db.prepare("SELECT * FROM projects").all();

  function hasActiveRun(projectId, issueNumber) {
    return !!db
      .prepare(
        `SELECT 1 FROM runs WHERE project_id=? AND issue_number=?
         AND state NOT IN ('failed','merged','decomposed')`,
      )
      .get(projectId, issueNumber);
  }

  function nextAttempt(projectId, issueNumber) {
    const r = db
      .prepare(
        "SELECT MAX(attempt) a FROM runs WHERE project_id=? AND issue_number=?",
      )
      .get(projectId, issueNumber);
    return (r.a || 0) + 1;
  }

  function depsFor(projectId, issueNumber) {
    return db
      .prepare(
        "SELECT depends_on_issue_number d FROM issue_deps WHERE project_id=? AND issue_number=?",
      )
      .all(projectId, issueNumber)
      .map((x) => x.d);
  }

  async function allDepsClosed(repo, projectId, issueNumber) {
    for (const d of depsFor(projectId, issueNumber)) {
      const iss = await gh.issue(repo, d);
      if (!(iss.closed || iss.state === "CLOSED")) return false;
    }
    return true;
  }

  async function tick() {
    for (const p of projects()) {
      // 1. enqueue newly labeled issues
      const issues = await gh.listLabeledIssues(p.repo, p.watch_label);
      for (const iss of issues) {
        if (hasActiveRun(p.id, iss.number)) continue;
        const attempt = nextAttempt(p.id, iss.number);
        const blocked = !(await allDepsClosed(p.repo, p.id, iss.number));
        db.prepare(
          `INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(
          p.id,
          iss.number,
          blocked ? "blocked" : "queued",
          attempt,
          new Date().toISOString(),
          new Date().toISOString(),
        );
        try {
          await gh.swapLabel(p.repo, iss.number, p.watch_label, "in-progress");
        } catch {}
      }

      // 2. unblock dependents whose blockers are now closed
      const blockedRuns = db
        .prepare("SELECT * FROM runs WHERE project_id=? AND state='blocked'")
        .all(p.id);
      for (const r of blockedRuns) {
        if (await allDepsClosed(p.repo, p.id, r.issue_number))
          transition(db, r.id, "queued", {
            stage: "poller",
            message: "dependencies satisfied",
          });
      }

      // 3. detect merged: pr_open run whose issue is now closed
      const open = db
        .prepare("SELECT * FROM runs WHERE project_id=? AND state='pr_open'")
        .all(p.id);
      for (const r of open) {
        const iss = await gh.issue(p.repo, r.issue_number);
        if (iss.closed || iss.state === "CLOSED") {
          transition(db, r.id, "merged", { stage: "poller", message: "issue closed" });
          if (workspace && r.worktree_path) {
            try {
              await workspace.removeWorktree(p, r.worktree_path, {
                deleteBranch: true,
                branch: r.branch,
              });
            } catch {}
          }
        }
      }
    }
  }

  return { tick };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/poller.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/poller.js test/poller.test.js
git commit -m "feat: poller (enqueue/claim, blocked, unblock, merged detection)"
```

---

## Phase 3: Decomposition + dependency graph

### Task 18: Cycle detection

**Files:**
- Create: `src/dag.js`
- Test: `test/dag.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/dag.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasCycle } from "../src/dag.js";

test("acyclic returns false", () => {
  assert.equal(
    hasCycle([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["a", "b"] },
    ]),
    false,
  );
});

test("self-loop is a cycle", () => {
  assert.equal(hasCycle([{ key: "a", dependsOn: ["a"] }]), true);
});

test("two-node cycle detected", () => {
  assert.equal(
    hasCycle([
      { key: "a", dependsOn: ["b"] },
      { key: "b", dependsOn: ["a"] },
    ]),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dag.test.js`
Expected: FAIL — cannot find `../src/dag.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/dag.js
export function hasCycle(nodes) {
  const graph = new Map(nodes.map((n) => [n.key, n.dependsOn || []]));
  const state = new Map(); // key -> 0 unvisited,1 in-stack,2 done
  function dfs(k) {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const dep of graph.get(k) || []) {
      if (dfs(dep)) return true;
    }
    state.set(k, 2);
    return false;
  }
  for (const n of nodes) if (dfs(n.key)) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dag.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dag.js test/dag.test.js
git commit -m "feat: DAG cycle detection"
```

### Task 19: Decompose (create sub-issues + issue_deps)

**Files:**
- Create: `src/decompose.js`
- Test: `test/decompose.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/decompose.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { decompose } from "../src/decompose.js";

function ctx(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,2,'decomposing',1,'t','t')",
  ).run();
  return {
    project: db.prepare("SELECT * FROM projects WHERE id=1").get(),
    parentRun: db.prepare("SELECT * FROM runs WHERE id=1").get(),
  };
}

test("creates sub-issues with watch label and records deps", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = ctx(db);
  const created = [];
  let n = 100;
  const gh = {
    createIssue: async (_r, { title }) => {
      created.push(title);
      return { number: ++n };
    },
    setLabel: async () => {},
    comment: async () => {},
  };
  await decompose({
    db, gh, project, parentRun,
    subIssues: [
      { key: "api", title: "API", body: "build api", dependsOn: [] },
      { key: "ui", title: "UI", body: "build ui", dependsOn: ["api"] },
    ],
  });
  assert.deepEqual(created, ["API", "UI"]);
  // ui (102) depends on api (101)
  const dep = db
    .prepare("SELECT * FROM issue_deps WHERE project_id=1 AND issue_number=102")
    .get();
  assert.equal(dep.depends_on_issue_number, 101);
});

test("cyclic DAG rejected before any issue is created", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = ctx(db);
  let calls = 0;
  const gh = { createIssue: async () => (calls++, { number: 1 }), setLabel: async () => {} };
  await assert.rejects(
    decompose({
      db, gh, project, parentRun,
      subIssues: [
        { key: "a", title: "A", body: "", dependsOn: ["b"] },
        { key: "b", title: "B", body: "", dependsOn: ["a"] },
      ],
    }),
    /cyclic/,
  );
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/decompose.test.js`
Expected: FAIL — cannot find `../src/decompose.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/decompose.js
import { hasCycle } from "./dag.js";

export async function decompose({ db, gh, project, parentRun, subIssues }) {
  if (!subIssues || subIssues.length === 0)
    throw new Error("decompose: no sub-issues proposed");
  if (hasCycle(subIssues))
    throw new Error("decompose: cyclic sub-issue dependency graph");

  const keyToNumber = new Map();
  const links = [];
  for (const s of subIssues) {
    const body = `${s.body || ""}\n\n_(sub-issue of #${parentRun.issue_number})_`;
    const { number } = await gh.createIssue(project.repo, {
      title: s.title,
      body,
    });
    keyToNumber.set(s.key, number);
    try {
      await gh.setLabel(project.repo, number, project.watch_label);
    } catch {}
    links.push([number, s.dependsOn || []]);
  }

  const insDep = db.prepare(
    `INSERT OR IGNORE INTO issue_deps
     (project_id,issue_number,depends_on_issue_number) VALUES (?,?,?)`,
  );
  for (const [number, deps] of links) {
    for (const k of deps) {
      const depNum = keyToNumber.get(k);
      if (depNum) insDep.run(project.id, number, depNum);
    }
  }

  // render parent rollup
  const list = subIssues
    .map((s) => `- [ ] #${keyToNumber.get(s.key)} ${s.title}` +
      (s.dependsOn?.length
        ? ` (blocked by ${s.dependsOn.map((k) => `#${keyToNumber.get(k)}`).join(", ")})`
        : ""))
    .join("\n");
  try {
    await gh.comment(
      project.repo,
      parentRun.issue_number,
      `Decomposed into sub-issues:\n\n${list}`,
    );
  } catch {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/decompose.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/decompose.js test/decompose.test.js
git commit -m "feat: decomposition into dependency-ordered sub-issues"
```

---

## Phase 4: Rebase-conflict resolution + PR-maintenance sweep

### Task 20: rebase-conflict resolution stage

**Files:**
- Create: `src/stages/resolveConflict.js`
- Test: `test/resolveConflict.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/resolveConflict.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runResolveConflict } from "../src/stages/resolveConflict.js";

test("returns resolved=true when claude reports success", async () => {
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"resolved":true,"summary":"merged both sides"}
RESULT>>>`,
    }),
  };
  const r = await runResolveConflict({
    claude, cwd: "/wt", files: ["a.js"], timeoutMs: 100,
  });
  assert.equal(r.resolved, true);
});

test("throws when claude cannot resolve", async () => {
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"resolved":false,"summary":"semantic conflict"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runResolveConflict({ claude, cwd: "/wt", files: ["a.js"], timeoutMs: 100 }),
    /rebase-resolve: semantic conflict/,
  );
});

test("timeout throws", async () => {
  const claude = { run: async () => ({ code: 1, timedOut: true, stdout: "", stderr: "" }) };
  await assert.rejects(
    runResolveConflict({ claude, cwd: "/wt", files: [], timeoutMs: 1 }),
    /rebase-resolve: timed out/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resolveConflict.test.js`
Expected: FAIL — cannot find `../src/stages/resolveConflict.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/stages/resolveConflict.js
import { parseResultBlock } from "./parse.js";

export function buildResolvePrompt(files) {
  return `A git rebase onto the base branch is in progress with conflicts in:
${files.join("\n")}

Resolve ONLY these conflicts correctly (preserve the intent of both sides),
\`git add\` them, and continue the rebase (\`git rebase --continue\`) until it
completes. Then ensure the project's tests still pass.

Output ONLY this block:
<<<RESULT
{"resolved":true|false,"summary":"<what you did / why not>"}
RESULT>>>`;
}

export async function runResolveConflict({ claude, cwd, files, timeoutMs }) {
  const res = await claude.run({
    cwd,
    prompt: buildResolvePrompt(files),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("rebase-resolve: timed out");
  if (res.code !== 0)
    throw new Error(`rebase-resolve: claude exited ${res.code}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.resolved)
    throw new Error(`rebase-resolve: ${parsed.summary || "unresolved"}`);
  return { resolved: true, summary: parsed.summary || "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resolveConflict.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/resolveConflict.js test/resolveConflict.test.js
git commit -m "feat: bounded rebase-conflict resolution stage"
```

### Task 21: Wire conflict resolution into the executor sync checkpoint

**Files:**
- Modify: `src/executor.js`
- Test: `test/executor-rebase.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/executor-rebase.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";

function base(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

const gh = {
  issue: async () => ({ number: 8, title: "T", body: "B", state: "OPEN" }),
  comment: async () => {}, swapLabel: async () => {}, setLabel: async () => {},
};

test("conflict at sync checkpoint triggers resolve stage then continues", async () => {
  const db = openDb(":memory:");
  const run = base(db);
  let resolveCalled = 0;
  const workspace = {
    prepareClone: async () => "sha",
    addWorktree: async () => ({ path: "/wt", branch: "claude/8-o-r" }),
    removeWorktree: async () => {},
    rebaseOnBase: async () => ({ conflicted: true, files: ["x.js"] }),
  };
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve", notes: "", checklist: [] }),
    runPr: async () => ({ prUrl: "u" }),
    runResolveConflict: async () => {
      resolveCalled++;
      return { resolved: true };
    },
  };
  const ex = createExecutor({
    db, gh, workspace, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10 },
  });
  await ex.execute(run.id);
  assert.ok(resolveCalled >= 1);
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");
});

test("unresolved conflict fails the run", async () => {
  const db = openDb(":memory:");
  const run = base(db);
  const workspace = {
    prepareClone: async () => "sha",
    addWorktree: async () => ({ path: "/wt", branch: "b" }),
    removeWorktree: async () => {},
    rebaseOnBase: async () => ({ conflicted: true, files: ["x.js"] }),
  };
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve" }),
    runPr: async () => ({ prUrl: "u" }),
    runResolveConflict: async () => {
      throw new Error("rebase-resolve: semantic conflict");
    },
  };
  const ex = createExecutor({
    db, gh, workspace, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10 },
  });
  await ex.execute(run.id);
  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /rebase-resolve/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/executor-rebase.test.js`
Expected: FAIL — `rebaseOnBase` conflict path is not handled (resolve never called).

- [ ] **Step 3: Modify the executor**

In `src/executor.js`, replace **both** `await workspace.rebaseOnBase(project, wt.path); // sync checkpoint` lines with a call to a new helper, and add the helper inside `createExecutor` (before `execute`):

```js
  async function syncCheckpoint(run, project, wtPath) {
    const r = await workspace.rebaseOnBase(project, wtPath);
    if (!r.conflicted) return;
    await stages.runResolveConflict({
      claude: stages.claude,
      cwd: wtPath,
      files: r.files || [],
      timeoutMs: config.stageTimeoutMs,
    });
  }
```

Replace the first checkpoint line with:

```js
        await syncCheckpoint(run, project, wt.path); // before implement
```

Replace the second checkpoint line with:

```js
        await syncCheckpoint(run, project, wt.path); // before review
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/executor-rebase.test.js test/executor.test.js`
Expected: PASS (all — original executor tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/executor.js test/executor-rebase.test.js
git commit -m "feat: rebase-conflict resolution at executor sync checkpoints"
```

### Task 22: PR-maintenance sweep

**Files:**
- Create: `src/prSweep.js`
- Test: `test/prSweep.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/prSweep.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createPrSweep } from "../src/prSweep.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,worktree_path,pr_url,attempt,created_at,updated_at) VALUES (1,8,'pr_open','claude/8-o-r','/wt','https://github.com/o/r/pull/8',1,'t','t')",
  ).run();
}

test("BEHIND clean PR is rebased and force-pushed", async () => {
  const db = openDb(":memory:");
  seed(db);
  let pushed = false;
  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "BEHIND" }),
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: false }),
    pushBranch: async () => (pushed = true),
  };
  const sweep = createPrSweep({ db, gh, workspace, stages: {}, config: { stageTimeoutMs: 10 } });
  await sweep.tick();
  assert.equal(pushed, true);
});

test("conflicting PR runs resolve stage then pushes", async () => {
  const db = openDb(":memory:");
  seed(db);
  let resolved = false;
  let pushed = false;
  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY" }),
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: true, files: ["a.js"] }),
    pushBranch: async () => (pushed = true),
  };
  const stages = {
    runResolveConflict: async () => {
      resolved = true;
      return { resolved: true };
    },
  };
  const sweep = createPrSweep({ db, gh, workspace, stages, config: { stageTimeoutMs: 10 } });
  await sweep.tick();
  assert.equal(resolved, true);
  assert.equal(pushed, true);
});

test("unresolvable conflict flags needs_attention, no push", async () => {
  const db = openDb(":memory:");
  seed(db);
  let pushed = false;
  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY" }),
    comment: async () => {},
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: true, files: ["a.js"] }),
    pushBranch: async () => (pushed = true),
    abortRebase: async () => {},
  };
  const stages = {
    runResolveConflict: async () => {
      throw new Error("rebase-resolve: semantic conflict");
    },
  };
  const sweep = createPrSweep({ db, gh, workspace, stages, config: { stageTimeoutMs: 10 } });
  await sweep.tick();
  assert.equal(pushed, false);
  const r = db.prepare("SELECT needs_attention, attention_reason FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 1);
  assert.match(r.attention_reason, /rebase-resolve/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prSweep.test.js`
Expected: FAIL — cannot find `../src/prSweep.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/prSweep.js
export function createPrSweep({ db, gh, workspace, stages, config }) {
  async function tick() {
    const projects = db.prepare("SELECT * FROM projects").all();
    for (const p of projects) {
      const runs = db
        .prepare(
          "SELECT * FROM runs WHERE project_id=? AND state='pr_open' AND needs_attention=0",
        )
        .all(p.id);
      for (const r of runs) {
        let status;
        try {
          status = await gh.prStatus(p.repo, r.branch);
        } catch {
          continue;
        }
        if (status.state !== "OPEN") continue;
        const behind = ["BEHIND", "DIRTY", "UNKNOWN"].includes(
          status.mergeStateStatus,
        );
        if (!behind) continue;
        if (!r.worktree_path) continue; // worktree gone post-PR; skip (manual)

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
            try {
              await workspace.abortRebase(p, r.worktree_path);
            } catch {}
            db.prepare(
              "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
            ).run(e.message, r.id);
            try {
              await gh.comment(
                p.repo,
                r.issue_number,
                `PR rebase blocked: ${e.message}`,
              );
            } catch {}
            continue;
          }
        }
        try {
          await workspace.pushBranch(p, r.worktree_path, r.branch);
        } catch (e) {
          db.prepare(
            "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
          ).run(`push failed: ${e.message}`, r.id);
        }
      }
    }
  }
  return { tick };
}
```

> Note: this changes the post-PR teardown — the worktree must be **kept**
> while the PR is open so the sweep can rebase it. Task 23 adjusts the
> executor accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/prSweep.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/prSweep.js test/prSweep.test.js
git commit -m "feat: PR-maintenance sweep with conflict handling"
```

### Task 23: Keep worktree while PR open; remove on merged

**Files:**
- Modify: `src/executor.js`
- Test: `test/executor-keep-worktree.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/executor-keep-worktree.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";

test("pr_open keeps the worktree (sweep needs it)", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  let removed = false;
  const workspace = {
    prepareClone: async () => "s",
    addWorktree: async () => ({ path: "/wt", branch: "b" }),
    rebaseOnBase: async () => ({ conflicted: false }),
    removeWorktree: async () => (removed = true),
  };
  const gh = {
    issue: async () => ({ number: 8, title: "T", body: "B" }),
    comment: async () => {}, swapLabel: async () => {},
  };
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve" }),
    runPr: async () => ({ prUrl: "u" }),
  };
  const ex = createExecutor({
    db, gh, workspace, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10 },
  });
  await ex.execute(1);
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");
  assert.equal(removed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/executor-keep-worktree.test.js`
Expected: FAIL — executor currently removes the worktree on `pr_open`.

- [ ] **Step 3: Modify the executor**

In `src/executor.js`, in the success path, **delete** this line that follows the `pr-open` label swap:

```js
      await workspace.removeWorktree(project, wt.path, {});
```

(The poller's `merged` handler — Task 17 — already removes the worktree and
deletes the branch when the issue closes. The `decomposed` path keeps its
`removeWorktree` call.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/executor-keep-worktree.test.js test/executor.test.js test/executor-rebase.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/executor.js test/executor-keep-worktree.test.js
git commit -m "fix: retain worktree while PR open so sweep can rebase it"
```

---

## Phase 5: Control surface (API, CLI, dashboard, server wiring)

### Task 24: API routes

**Files:**
- Create: `src/api.js`
- Test: `test/api.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/api.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../src/db.js";
import { mountApi } from "../src/api.js";

function appWith(db, deps) {
  const app = express();
  app.use(express.json());
  mountApi(app, { db, ...deps });
  return app;
}

async function call(app, method, path, body) {
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  server.close();
  return { status: res.status, json };
}

test("POST /projects registers", async () => {
  const db = openDb(":memory:");
  const projects = {
    register: async (a) => ({ slug: "o-r", repo: a.repo }),
    list: () => [],
  };
  const app = appWith(db, { projects });
  const r = await call(app, "POST", "/projects", {
    repo: "o/r", watchLabel: "claude-dev", baseBranch: "main",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.slug, "o-r");
});

test("GET /runs lists rows", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  const app = appWith(db, {});
  const r = await call(app, "GET", "/runs");
  assert.equal(r.status, 200);
  assert.equal(r.json.runs.length, 1);
  assert.equal(r.json.runs[0].issue_number, 8);
});

test("POST /runs/:id/retry inserts a new attempt", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'failed',1,'t','t')",
  ).run();
  const app = appWith(db, {});
  const r = await call(app, "POST", "/runs/1/retry");
  assert.equal(r.status, 200);
  const fresh = db
    .prepare("SELECT * FROM runs WHERE issue_number=8 AND attempt=2")
    .get();
  assert.equal(fresh.state, "queued");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api.test.js`
Expected: FAIL — cannot find `../src/api.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/api.js
export function mountApi(app, { db, projects, poller, scheduler }) {
  app.post("/projects", async (req, res) => {
    try {
      const p = await projects.register({
        repo: req.body.repo,
        watchLabel: req.body.watchLabel,
        baseBranch: req.body.baseBranch,
      });
      res.json(p);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/projects", (_req, res) => {
    res.json({ projects: projects ? projects.list() : [] });
  });

  app.delete("/projects/:slug", (req, res) => {
    projects.remove(req.params.slug);
    res.json({ ok: true });
  });

  app.get("/runs", (req, res) => {
    const { state, project } = req.query;
    let sql = "SELECT * FROM runs";
    const where = [];
    const args = [];
    if (state) (where.push("state=?"), args.push(state));
    if (project) (where.push("project_id=?"), args.push(Number(project)));
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY id DESC";
    res.json({ runs: db.prepare(sql).all(...args) });
  });

  app.get("/runs/:id", (req, res) => {
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    res.json({
      run,
      logs: db
        .prepare("SELECT * FROM run_logs WHERE run_id=? ORDER BY id")
        .all(run.id),
      artifacts: db
        .prepare("SELECT kind,content FROM run_artifacts WHERE run_id=?")
        .all(run.id),
    });
  });

  app.post("/runs/:id/retry", (req, res) => {
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    const next =
      (db
        .prepare(
          "SELECT MAX(attempt) a FROM runs WHERE project_id=? AND issue_number=?",
        )
        .get(run.project_id, run.issue_number).a || 0) + 1;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(run.project_id, run.issue_number, "queued", next, now, now);
    res.json({ ok: true, attempt: next });
  });

  app.post("/runs/:id/cancel", (req, res) => {
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    db.prepare(
      "UPDATE runs SET state='failed', fail_reason='cancelled by user', updated_at=? WHERE id=?",
    ).run(new Date().toISOString(), run.id);
    res.json({ ok: true });
  });

  app.post("/poll", async (_req, res) => {
    if (poller) await poller.tick();
    if (scheduler) await scheduler.tick();
    res.json({ ok: true });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api.js test/api.test.js
git commit -m "feat: control-plane API routes"
```

### Task 25: Server wiring

**Files:**
- Modify: `server.js`
- Test: `test/server-wiring.test.js`

- [ ] **Step 1: Write the failing test**

This test imports a new `buildAutonomous` factory (extracted so it is testable without binding a port).

```js
// test/server-wiring.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutonomous } from "../src/wire.js";

test("buildAutonomous returns wired components", () => {
  const a = buildAutonomous({ env: { DB_PATH: ":memory:" } });
  assert.ok(a.db);
  assert.ok(a.poller);
  assert.ok(a.scheduler);
  assert.ok(a.prSweep);
  assert.equal(typeof a.mount, "function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-wiring.test.js`
Expected: FAIL — cannot find `../src/wire.js`.

- [ ] **Step 3: Create `src/wire.js`**

```js
// src/wire.js
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createKeyedMutex } from "./mutex.js";
import { createGit } from "./adapters/git.js";
import { createGh } from "./adapters/gh.js";
import { createClaude } from "./adapters/claude.js";
import { createProjects } from "./projects.js";
import { createWorkspace } from "./workspace.js";
import { createExecutor } from "./executor.js";
import { createScheduler } from "./scheduler.js";
import { createPoller } from "./poller.js";
import { createPrSweep } from "./prSweep.js";
import { decompose } from "./decompose.js";
import { runSpecPlan } from "./stages/specPlan.js";
import { runImplement } from "./stages/implement.js";
import { runReview } from "./stages/review.js";
import { runPr } from "./stages/pr.js";
import { runResolveConflict } from "./stages/resolveConflict.js";
import { mountApi } from "./api.js";

export function buildAutonomous({ env = process.env } = {}) {
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  const mutex = createKeyedMutex();
  const git = createGit();
  const gh = createGh({ bin: config.ghBin });
  const claude = createClaude({ bin: config.claudeBin });
  const projects = createProjects({
    db,
    git,
    projectsDir: config.projectsDir,
  });
  const workspace = createWorkspace({
    git,
    mutex,
    worktreesDir: config.worktreesDir,
  });
  const stages = {
    claude,
    runSpecPlan,
    runImplement,
    runReview,
    runPr,
    runResolveConflict,
  };
  const executor = createExecutor({
    db, gh, workspace, stages, decompose, config,
  });
  const scheduler = createScheduler({
    db,
    executor,
    maxConcurrentRuns: config.maxConcurrentRuns,
  });
  const poller = createPoller({ db, gh, workspace });
  const prSweep = createPrSweep({ db, gh, workspace, stages, config });

  function mount(app) {
    mountApi(app, { db, projects, poller, scheduler });
  }

  return { config, db, projects, workspace, executor, scheduler, poller, prSweep, mount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-wiring.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Wire intervals into `server.js`**

In `server.js`, after the existing `const app = express();` / `app.use(express.json(...))` / static / auth-middleware block and before `app.listen(...)`, add:

```js
import { buildAutonomous } from "./src/wire.js";

const autonomous = buildAutonomous({ env: process.env });
autonomous.mount(app);

setInterval(
  () =>
    autonomous.poller
      .tick()
      .then(() => autonomous.scheduler.tick())
      .catch((e) => console.error("poll/sched err:", e.message)),
  autonomous.config.issuePollMs,
).unref();

setInterval(
  () =>
    autonomous.prSweep
      .tick()
      .catch((e) => console.error("prSweep err:", e.message)),
  autonomous.config.prSyncMs,
).unref();

console.log(
  `autonomous-dev wired: poll=${autonomous.config.issuePollMs}ms prSync=${autonomous.config.prSyncMs}ms maxRuns=${autonomous.config.maxConcurrentRuns}`,
);
```

(Place the `import` at the top with the other imports. The autonomous API
routes are added before `app.listen`; the existing auth middleware already
protects all non-`/`, non-`/healthz` paths, so the new routes are
token-guarded automatically.)

- [ ] **Step 6: Verify server still starts**

Run: `AUTONOMOUS_DIR=/tmp/auton-smoke DB_PATH=/tmp/auton-smoke.db timeout 3 node server.js`
Expected: logs include `autonomous-dev wired:` and the existing
`headless-claude on ...` line, no crash. (Exit via timeout is fine.)

- [ ] **Step 7: Commit**

```bash
git add src/wire.js server.js test/server-wiring.test.js
git commit -m "feat: wire autonomous subsystem into server with poll/sweep intervals"
```

### Task 26: `cdev` CLI

**Files:**
- Create: `cdev`
- Test: `test/cdev.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/cdev.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("cdev --help prints usage", () => {
  const r = spawnSync("bash", ["cdev", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cdev add/);
  assert.match(r.stdout, /cdev runs/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cdev.test.js`
Expected: FAIL — `cdev` does not exist (non-zero status).

- [ ] **Step 3: Write minimal implementation**

```bash
#!/usr/bin/env bash
# cdev — control the headless-claude autonomous dev subsystem.
#
# Usage:
#   cdev add <owner/repo> --label <L> --base <B>   register + clone a project
#   cdev projects                                   list projects
#   cdev runs [--state S]                           list runs
#   cdev logs <run-id>                              show a run's logs
#   cdev retry <run-id>                             re-queue a failed run
#   cdev poll                                       force a poll+schedule tick
set -euo pipefail

ENV_FILE="${HEADLESS_CLAUDE_ENV:-/home/talhabera/claude-projects/headless-claude/.env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
HOST="${HOST:-127.0.0.1}"; PORT="${PORT:-3000}"
TOKEN="${AUTH_TOKEN:?AUTH_TOKEN not set in $ENV_FILE}"
api() { curl -fsS -H "Authorization: Bearer ${TOKEN}" "$@"; }
BASE="http://${HOST}:${PORT}"

cmd="${1:-}"; shift || true
case "$cmd" in
  -h|--help|"") sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  add)
    repo="$1"; shift
    label="claude-dev"; base="main"
    while [ $# -gt 0 ]; do case "$1" in
      --label) label="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      *) shift ;;
    esac; done
    api -X POST "${BASE}/projects" -H 'Content-Type: application/json' \
      -d "$(printf '{"repo":"%s","watchLabel":"%s","baseBranch":"%s"}' "$repo" "$label" "$base")"
    echo ;;
  projects) api "${BASE}/projects"; echo ;;
  runs)
    q=""; [ "${1:-}" = "--state" ] && q="?state=$2"
    api "${BASE}/runs${q}"; echo ;;
  logs) api "${BASE}/runs/$1"; echo ;;
  retry) api -X POST "${BASE}/runs/$1/retry"; echo ;;
  poll) api -X POST "${BASE}/poll"; echo ;;
  *) echo "cdev: unknown command '$cmd'" >&2; exit 1 ;;
esac
```

- [ ] **Step 4: Make executable and run test to verify it passes**

Run: `chmod +x cdev && node --test test/cdev.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add cdev test/cdev.test.js
git commit -m "feat: cdev CLI for the autonomous subsystem"
```

### Task 27: Dashboard runs view

**Files:**
- Modify: `public/index.html`
- Test: `test/dashboard.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/dashboard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard has a runs section that fetches /runs", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /id="runs"/);
  assert.match(html, /\/runs/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard.test.js`
Expected: FAIL — `public/index.html` has no `id="runs"`.

- [ ] **Step 3: Append a runs panel to `public/index.html`**

Read `public/index.html` first to find the closing `</body>`. Insert this
block immediately before `</body>` (it reuses the page's existing token
handling pattern — if the page already defines a `token` variable/query
param, reuse it; otherwise this reads `?token=` from the URL):

```html
<section id="runs">
  <h2>Autonomous Runs</h2>
  <table id="runs-table" border="1" cellpadding="4">
    <thead><tr><th>ID</th><th>Issue</th><th>State</th><th>PR</th><th>Attn</th></tr></thead>
    <tbody></tbody>
  </table>
  <script>
    (function () {
      var tok = new URLSearchParams(location.search).get("token") || "";
      function refresh() {
        fetch("/runs", { headers: { Authorization: "Bearer " + tok } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var b = document.querySelector("#runs-table tbody");
            b.innerHTML = (d.runs || [])
              .map(function (x) {
                return "<tr><td>" + x.id + "</td><td>#" + x.issue_number +
                  "</td><td>" + x.state + "</td><td>" +
                  (x.pr_url ? "<a href='" + x.pr_url + "'>PR</a>" : "") +
                  "</td><td>" + (x.needs_attention ? "⚠" : "") + "</td></tr>";
              })
              .join("");
          })
          .catch(function () {});
      }
      refresh();
      setInterval(refresh, 5000);
    })();
  </script>
</section>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dashboard.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/dashboard.test.js
git commit -m "feat: dashboard runs panel"
```

### Task 28: Full integration test + crash-recovery reconcile

**Files:**
- Create: `src/reconcile.js`
- Modify: `src/wire.js`
- Test: `test/integration.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/integration.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import { createPoller } from "../src/poller.js";
import { reconcileOnStartup } from "../src/reconcile.js";

test("labeled issue flows queued → pr_open via poller+scheduler", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  const gh = {
    listLabeledIssues: async () => [{ number: 8, title: "Feat", body: "do it" }],
    swapLabel: async () => {},
    setLabel: async () => {},
    comment: async () => {},
    issue: async () => ({ number: 8, title: "Feat", body: "do it", state: "OPEN" }),
  };
  const workspace = {
    prepareClone: async () => "sha",
    addWorktree: async () => ({ path: "/wt", branch: "claude/8-o-r" }),
    rebaseOnBase: async () => ({ conflicted: false }),
    removeWorktree: async () => {},
  };
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve" }),
    runPr: async ({ db, run }) => {
      db.prepare("UPDATE runs SET pr_url='u' WHERE id=?").run(run.id);
      return { prUrl: "u" };
    },
  };
  const executor = createExecutor({
    db, gh, workspace, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10 },
  });
  const scheduler = createScheduler({ db, executor, maxConcurrentRuns: 2 });
  const poller = createPoller({ db, gh, workspace });

  await poller.tick();
  await scheduler.drain();

  const run = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(run.state, "pr_open");
  assert.equal(run.pr_url, "u");
});

test("reconcileOnStartup re-queues a stranded non-terminal run", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'implementing',1,'t','t')",
  ).run();
  reconcileOnStartup(db);
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=8").get().state,
    "queued",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration.test.js`
Expected: FAIL — cannot find `../src/reconcile.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/reconcile.js
// On process start, runs left mid-flight (process died) are reset to
// 'queued' so the scheduler re-drives them from the start. Artifacts are
// preserved, so completed stages can be skipped by future smarter logic;
// for now a clean re-run from queued is correct and safe (idempotent:
// worktree add is per (issue,attempt); a stale worktree is pruned first).
const ACTIVE = ["spec_plan", "implementing", "reviewing", "decomposing"];

export function reconcileOnStartup(db) {
  const stranded = db
    .prepare(
      `SELECT id FROM runs WHERE state IN (${ACTIVE.map(() => "?").join(",")})`,
    )
    .all(...ACTIVE);
  const now = new Date().toISOString();
  for (const { id } of stranded) {
    db.prepare(
      "UPDATE runs SET state='queued', updated_at=? WHERE id=?",
    ).run(now, id);
    db.prepare(
      "INSERT INTO run_logs (run_id,stage,level,message,ts) VALUES (?,?,?,?,?)",
    ).run(id, "reconcile", "warn", "re-queued after restart", now);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/integration.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Call reconcile on startup**

In `src/wire.js`, add the import at the top:

```js
import { reconcileOnStartup } from "./reconcile.js";
```

and call it immediately after `const db = openDb(config.dbPath);`:

```js
  reconcileOnStartup(db);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — all test files green.

- [ ] **Step 7: Commit**

```bash
git add src/reconcile.js src/wire.js test/integration.test.js
git commit -m "feat: startup reconcile + full integration test"
```

---

## Final verification

- [ ] **Step 1: Whole suite green**

Run: `npm test`
Expected: every `test/*.test.js` passes, no failures.

- [ ] **Step 2: Server smoke**

Run: `AUTONOMOUS_DIR=/tmp/auton-final DB_PATH=/tmp/auton-final.db timeout 3 node server.js`
Expected: both the existing pool log line and `autonomous-dev wired:` appear; no stack traces.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: autonomous dev subsystem complete" --allow-empty
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** registry (T8), SQLite store/schema (T2), poller incl.
  blocked/unblock/merged (T17), scheduler global cap (T16), executor 4 gates —
  spec+plan self-review (T11), TDD green-gate (T12), independent review (T13),
  acceptance checklist in PR (T14); decision-gate decomposition + DAG/cycle
  (T18–T19); parallelism: semaphore (T16) + per-project mutex (T3, used in
  T9); auto-rebase sync checkpoints + resolution (T20–T21); PR-maintenance
  sweep (T22); worktree lifecycle incl. keep-while-PR (T9, T23); control
  surface API/CLI/dashboard (T24, T26, T27); crash recovery (T28). All spec
  sections map to tasks.
- **Type consistency:** stage functions (`runSpecPlan/runImplement/runReview/
  runPr/runResolveConflict`) have identical signatures across executor,
  prSweep, and wire. `workspace` method names (`prepareClone`, `addWorktree`,
  `rebaseOnBase`, `abortRebase`, `pushBranch`, `removeWorktree`) are
  consistent across workspace.js, executor, prSweep, poller. `gh` method
  names consistent across adapter, poller, decompose, pr, executor.
- **No placeholders:** every step ships runnable code/commands with expected
  output.
- **Deferred-by-design (spec “out of scope”):** webhooks, per-project quota,
  PR stacking, continuous rebase, auto-merge — intentionally not tasked.
