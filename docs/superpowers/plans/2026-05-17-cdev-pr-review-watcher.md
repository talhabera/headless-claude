# cdev PR Review Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class, always-on watcher to the headless-claude autonomous subsystem that reviews cdev's own open PRs with code-review rigor, auto-fixes and re-reviews until approve (capped), acts on the user's PR comments, and never merges.

**Architecture:** A new `src/prReview.js` module (sibling to `src/prSweep.js`) exposing `tick()`, constructed in `src/wire.js` and driven by a dedicated `setInterval` in `server.js` after the existing `prSweep` interval. It operates only on runs in `state='pr_open'`, drives two new claude stages (`prReview`, `prFix`) in the run's worktree behind the existing per-project mutex, and tracks loop state in four new idempotently-migrated `runs` columns.

**Tech Stack:** Node 20, ESM, `better-sqlite3`, `express`. Tests: `node --test` with `openDb(':memory:')` and fake adapters (offline). No build, no linter.

**Spec:** `docs/superpowers/specs/2026-05-17-cdev-pr-review-watcher-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/db.js` | Add 4 idempotent `runs` columns | Modify |
| `src/config.js` | Add `prReviewMs`, `prReviewMaxIterations`, `botLogin` | Modify |
| `src/adapters/gh.js` | Add `prComments`, `prComment`, `viewer` | Modify |
| `src/workspace.js` | Add `diffFingerprint` (git patch-id behind mutex) | Modify |
| `src/stages/prReview.js` | `runPrReview` stage (code-review verdict) | Create |
| `src/stages/prFix.js` | `runPrFix` stage (implement a change request) | Create |
| `src/prReview.js` | `createPrReview({...}).tick()` orchestration | Create |
| `src/wire.js` | Construct + return `prReview` | Modify |
| `server.js` | New interval + startup log | Modify |
| `test/db-pr-review-columns.test.js` | Migration tests | Create |
| `test/config-pr-review.test.js` | Config tests | Create |
| `test/gh-pr.test.js` | gh adapter tests | Create |
| `test/workspace-difffingerprint.test.js` | workspace test | Create |
| `test/stages-prReview.test.js` | prReview stage tests | Create |
| `test/stages-prFix.test.js` | prFix stage tests | Create |
| `test/prReview.test.js` | tick() orchestration tests | Create |
| `test/server-wiring.test.js` | Assert `prReview` wired | Modify |

---

## Task 1: Schema migration — 4 new `runs` columns

**Files:**
- Modify: `src/db.js`
- Test: `test/db-pr-review-columns.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/db-pr-review-columns.test.js`:

```javascript
// test/db-pr-review-columns.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

const NEW_COLS = [
  "pr_phase",
  "pr_reviewed_diff_id",
  "pr_review_iterations",
  "pr_last_comment_at",
];

test("fresh :memory: db has the 4 pr-review columns on runs", () => {
  const db = openDb(":memory:");
  const cols = db
    .prepare("PRAGMA table_info(runs)")
    .all()
    .map((r) => r.name);
  for (const c of NEW_COLS) assert.ok(cols.includes(c), `missing ${c}`);
});

test("openDb migrates a pre-existing runs table WITHOUT the new columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-prr-"));
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
    const cols = db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((r) => r.name);
    for (const c of NEW_COLS) assert.ok(cols.includes(c), `missing ${c}`);
    // existing row preserved, new cols default sensibly
    const row = db.prepare("SELECT * FROM runs WHERE id=1").get();
    assert.equal(row.pr_review_iterations, 0);
    assert.equal(row.pr_phase, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDb is idempotent — second open does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-prr2-"));
  const dbPath = join(dir, "test.db");
  try {
    openDb(dbPath).close();
    assert.doesNotThrow(() => openDb(dbPath).close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db-pr-review-columns.test.js`
Expected: FAIL — `missing pr_phase` (columns not yet added).

- [ ] **Step 3: Add the columns to the schema and the migration block**

In `src/db.js`, add the 4 columns to the `runs` `CREATE TABLE` in the `SCHEMA` string (so fresh DBs get them) — append after `attention_reason TEXT,` and before `created_at TEXT, updated_at TEXT,`:

```javascript
  attention_reason TEXT,
  pr_phase TEXT,
  pr_reviewed_diff_id TEXT,
  pr_review_iterations INTEGER DEFAULT 0,
  pr_last_comment_at TEXT,
  created_at TEXT, updated_at TEXT,
```

Then extend the existing idempotent migration. After the existing `projects` migration loop in `openDb`, add a `runs` loop mirroring the same pattern:

```javascript
  const runCols = db
    .prepare("PRAGMA table_info(runs)")
    .all()
    .map((r) => r.name);
  const runMigrations = [
    ["pr_phase", "TEXT"],
    ["pr_reviewed_diff_id", "TEXT"],
    ["pr_review_iterations", "INTEGER DEFAULT 0"],
    ["pr_last_comment_at", "TEXT"],
  ];
  for (const [col, type] of runMigrations) {
    if (!runCols.includes(col)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db-pr-review-columns.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/db-pr-review-columns.test.js
git commit -m "feat(db): add pr-review loop columns to runs (idempotent migration)"
```

---

## Task 2: Config — `prReviewMs`, `prReviewMaxIterations`, `botLogin`

**Files:**
- Modify: `src/config.js`
- Test: `test/config-pr-review.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/config-pr-review.test.js`:

```javascript
// test/config-pr-review.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("pr-review config defaults", () => {
  const c = loadConfig({});
  assert.equal(c.prReviewMs, 120000);
  assert.equal(c.prReviewMaxIterations, 4);
  assert.equal(c.botLogin, "");
});

test("pr-review config env overrides", () => {
  const c = loadConfig({
    PR_REVIEW_MS: "5000",
    PR_REVIEW_MAX_ITERATIONS: "2",
    PR_BOT_LOGIN: "my-bot",
  });
  assert.equal(c.prReviewMs, 5000);
  assert.equal(c.prReviewMaxIterations, 2);
  assert.equal(c.botLogin, "my-bot");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config-pr-review.test.js`
Expected: FAIL — `c.prReviewMs` is `undefined`.

- [ ] **Step 3: Add the config keys**

In `src/config.js`, inside the returned object (after `previewPollMs:` line), add:

```javascript
    prReviewMs: num(env.PR_REVIEW_MS, 120000),
    prReviewMaxIterations: num(env.PR_REVIEW_MAX_ITERATIONS, 4),
    botLogin: env.PR_BOT_LOGIN || "",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config-pr-review.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config-pr-review.test.js
git commit -m "feat(config): add prReviewMs, prReviewMaxIterations, botLogin"
```

---

## Task 3: gh adapter — `prComments`, `prComment`, `viewer`

**Files:**
- Modify: `src/adapters/gh.js`
- Test: `test/gh-pr.test.js`

The adapter accepts an injectable `runner` (see `defaultRunner`); tests pass a fake runner returning `{code,stdout,stderr}`.

- [ ] **Step 1: Write the failing test**

Create `test/gh-pr.test.js`:

```javascript
// test/gh-pr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGh } from "../src/adapters/gh.js";

test("prComments parses comments array", async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: JSON.stringify({
        comments: [
          { id: "C1", author: { login: "alice" }, body: "fix x", createdAt: "2026-05-17T10:00:00Z" },
        ],
      }),
      stderr: "",
    };
  };
  const gh = createGh({ runner });
  const out = await gh.prComments("o/r", "claude/8-o-r");
  assert.equal(out.length, 1);
  assert.equal(out[0].author.login, "alice");
  assert.deepEqual(calls[0].slice(0, 4), ["pr", "view", "claude/8-o-r", "-R"]);
  assert.ok(calls[0].includes("comments"));
});

test("prComments returns [] when no comments key", async () => {
  const gh = createGh({ runner: () => ({ code: 0, stdout: "{}", stderr: "" }) });
  assert.deepEqual(await gh.prComments("o/r", "b"), []);
});

test("prComment posts a body to the PR number", async () => {
  let seen;
  const gh = createGh({
    runner: (args) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await gh.prComment("o/r", 36, "hello");
  assert.deepEqual(seen, ["pr", "comment", "36", "-R", "o/r", "--body", "hello"]);
});

test("viewer returns the authenticated login trimmed", async () => {
  const gh = createGh({
    runner: (args) => {
      assert.deepEqual(args, ["api", "user", "-q", ".login"]);
      return { code: 0, stdout: "octo-bot\n", stderr: "" };
    },
  });
  assert.equal(await gh.viewer(), "octo-bot");
});

test("prComment surfaces gh failure", async () => {
  const gh = createGh({
    runner: () => ({ code: 1, stdout: "", stderr: "boom" }),
  });
  await assert.rejects(() => gh.prComment("o/r", 1, "x"), /pr comment failed: boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gh-pr.test.js`
Expected: FAIL — `gh.prComments is not a function`.

- [ ] **Step 3: Add the three methods**

In `src/adapters/gh.js`, inside the object returned by `createGh`, add after `prStatus`:

```javascript
    async prComments(repo, head) {
      const out = ok(
        run([
          "pr", "view", head, "-R", repo, "--json", "comments",
        ]),
        "pr comments",
      );
      const parsed = JSON.parse(out || "{}");
      return parsed.comments || [];
    },
    async prComment(repo, prNumber, body) {
      ok(
        run([
          "pr", "comment", String(prNumber), "-R", repo, "--body", body,
        ]),
        "pr comment",
      );
    },
    async viewer() {
      const out = ok(run(["api", "user", "-q", ".login"]), "api user");
      return out.trim();
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/gh-pr.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/gh.js test/gh-pr.test.js
git commit -m "feat(gh): add prComments, prComment, viewer adapter methods"
```

---

## Task 4: workspace — `diffFingerprint` (rebase-stable patch-id)

**Files:**
- Modify: `src/workspace.js`
- Test: `test/workspace-difffingerprint.test.js`

`createWorkspace({ git, mutex, worktreesDir })`; `git` is the injected adapter
`git(cwd, args) -> {code, stdout, stderr}`. `lock(project, fn)` is the existing
per-project mutex wrapper used by every method. We compute the patch-id of
`<base>...HEAD`: run `git diff <base>...HEAD`, then pipe through
`git patch-id --stable`. The injected `git` runner does not support pipes, so
do it in two calls and parse.

- [ ] **Step 1: Write the failing test**

Create `test/workspace-difffingerprint.test.js`:

```javascript
// test/workspace-difffingerprint.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../src/workspace.js";

function fakeMutex() {
  return { runExclusive: (_k, fn) => fn() };
}

test("diffFingerprint returns the patch-id hash for base...HEAD", async () => {
  const seen = [];
  const git = (cwd, args) => {
    seen.push(args.join(" "));
    if (args[0] === "diff") return { code: 0, stdout: "DIFFTEXT", stderr: "" };
    if (args[0] === "patch-id")
      return { code: 0, stdout: "abc123 0000000\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const ws = createWorkspace({ git, mutex: fakeMutex(), worktreesDir: "/tmp" });
  const fp = await ws.diffFingerprint(
    { base_branch: "main" },
    "/wt",
  );
  assert.equal(fp, "abc123");
  assert.ok(seen.some((s) => s.startsWith("diff main...HEAD")));
  assert.ok(seen.some((s) => s.startsWith("patch-id --stable")));
});

test("diffFingerprint returns empty-string sentinel when diff is empty", async () => {
  const git = (cwd, args) =>
    args[0] === "diff"
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: "\n", stderr: "" };
  const ws = createWorkspace({ git, mutex: fakeMutex(), worktreesDir: "/tmp" });
  const fp = await ws.diffFingerprint({ base_branch: "main" }, "/wt");
  assert.equal(fp, "");
});
```

> Note: confirm the existing mutex API name. `src/workspace.js` uses an
> internal `lock(project, fn)` built from `mutex`. Inspect the top of
> `src/workspace.js` for how `lock` is derived from `mutex` and reuse that
> exact call inside `diffFingerprint`; the fake above provides
> `runExclusive` — adjust the fake to whatever shape the real `lock` wraps
> (the other methods like `pushBranch` show the pattern to copy verbatim).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/workspace-difffingerprint.test.js`
Expected: FAIL — `ws.diffFingerprint is not a function`.

- [ ] **Step 3: Implement `diffFingerprint`**

In `src/workspace.js`, add a method alongside `pushBranch`, copying the exact
`lock(project, async () => {...})` wrapper the sibling methods use:

```javascript
    diffFingerprint(project, worktreePath) {
      return lock(project, async () => {
        const base = project.base_branch || "main";
        const d = git(worktreePath, ["diff", `${base}...HEAD`]);
        if (d.code !== 0) {
          throw new Error(`diff failed: ${d.stderr.trim()}`);
        }
        if (!d.stdout.trim()) return "";
        const p = git(worktreePath, ["patch-id", "--stable"], {
          input: d.stdout,
        });
        if (p.code !== 0) {
          throw new Error(`patch-id failed: ${p.stderr.trim()}`);
        }
        return (p.stdout.trim().split(/\s+/)[0]) || "";
      });
    },
```

> The injected `git(cwd, args, opts)` adapter (`src/adapters/git.js`) uses
> `spawnSync`. Verify it forwards an `input`/`stdin` option to `spawnSync`.
> If it does not, add a minimal `opts.input` passthrough to `git` in
> `src/adapters/git.js` (set `spawnSync(..., { input: opts.input })`) plus a
> one-line test in `test/git.test.js` asserting stdin is passed. Keep that
> change minimal and within this task's commit.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/workspace-difffingerprint.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass (including existing `test/workspace.test.js`, `test/git.test.js`).

- [ ] **Step 6: Commit**

```bash
git add src/workspace.js src/adapters/git.js test/workspace-difffingerprint.test.js test/git.test.js
git commit -m "feat(workspace): add rebase-stable diffFingerprint (git patch-id)"
```

---

## Task 5: `runPrReview` stage

**Files:**
- Create: `src/stages/prReview.js`
- Test: `test/stages-prReview.test.js`

Mirrors `src/stages/review.js`: build a prompt, run `claude`, parse the
`<<<RESULT … RESULT>>>` block via `parseResultBlock`, persist a verdict
artifact. Verdict normalizes to `approve | changes-requested`.

- [ ] **Step 1: Write the failing test**

Create `test/stages-prReview.test.js`:

```javascript
// test/stages-prReview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runPrReview, buildPrReviewPrompt } from "../src/stages/prReview.js";

function seedRun(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,worktree_path,created_at,updated_at) VALUES (1,8,'pr_open','b','/wt','t','t')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("buildPrReviewPrompt mentions code-review rigor and base diff", () => {
  const p = buildPrReviewPrompt("main");
  assert.match(p, /code-review/i);
  assert.match(p, /main\.\.\.HEAD|main\.\.HEAD/);
  assert.match(p, /DO NOT run `gh`/);
  assert.match(p, /<<<RESULT/);
});

test("runPrReview returns approve verdict and stores artifact", async () => {
  const db = openDb(":memory:");
  const run = seedRun(db);
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"verdict":"approve","findings":[],"notes":"ok"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const res = await runPrReview({
    db, run, claude, cwd: "/wt", base: "main", timeoutMs: 10,
  });
  assert.equal(res.verdict, "approve");
  const art = db
    .prepare("SELECT content FROM run_artifacts WHERE run_id=1 AND kind='pr_review_verdict'")
    .get();
  assert.ok(art && JSON.parse(art.content).verdict === "approve");
});

test("runPrReview normalizes any non-approve to changes-requested", async () => {
  const db = openDb(":memory:");
  const run = seedRun(db);
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"verdict":"changes-requested","findings":["hardcoded string"],"notes":"fix i18n"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const res = await runPrReview({ db, run, claude, cwd: "/wt", base: "main", timeoutMs: 10 });
  assert.equal(res.verdict, "changes-requested");
  assert.deepEqual(res.findings, ["hardcoded string"]);
});

test("runPrReview throws on claude non-zero exit", async () => {
  const db = openDb(":memory:");
  const run = seedRun(db);
  const claude = { run: async () => ({ code: 2, stdout: "", stderr: "bad" }) };
  await assert.rejects(
    () => runPrReview({ db, run, claude, cwd: "/wt", base: "main", timeoutMs: 10 }),
    /pr-review: claude exited 2/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stages-prReview.test.js`
Expected: FAIL — cannot import `../src/stages/prReview.js`.

- [ ] **Step 3: Implement the stage**

Create `src/stages/prReview.js`:

```javascript
// src/stages/prReview.js
import { parseResultBlock } from "./parse.js";

export function buildPrReviewPrompt(base) {
  return `You are an independent reviewer of an OPEN pull request. Review the
committed diff of \`${base}...HEAD\` in this worktree using superpowers
code-review rigor (correctness, security, tests, conventions, regressions).

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read files and run the project's tests/lint/typecheck to inform the review. Do NOT modify code in this stage.

Judge the committed diff only. The verdict MUST be \`changes-requested\` if
there is ANY correctness bug, security issue, missing/insufficient test for
changed behavior, or violation of a stated project convention (e.g. hardcoded
values where i18n/config keys are required). Otherwise \`approve\`.

Output ONLY this block:
<<<RESULT
{"verdict":"approve|changes-requested",
"findings":["<actionable finding>", "..."],"notes":"<summary>"}
RESULT>>>`;
}

export async function runPrReview({ db, run, claude, cwd, base, timeoutMs, signal }) {
  const res = await claude.run({
    cwd,
    prompt: buildPrReviewPrompt(base),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("pr-review: cancelled");
  if (res.timedOut) throw new Error("pr-review: timed out");
  if (res.code !== 0)
    throw new Error(`pr-review: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  db.prepare(
    `INSERT INTO run_artifacts (run_id,kind,content) VALUES (?,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET content=excluded.content`,
  ).run(run.id, "pr_review_verdict", JSON.stringify(parsed));
  return {
    verdict: parsed.verdict === "approve" ? "approve" : "changes-requested",
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    notes: parsed.notes || "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/stages-prReview.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/prReview.js test/stages-prReview.test.js
git commit -m "feat(stages): add runPrReview code-review stage"
```

---

## Task 6: `runPrFix` stage

**Files:**
- Create: `src/stages/prFix.js`
- Test: `test/stages-prFix.test.js`

Reuses the `runImplement` baseline-protocol + TDD prompt shape, but driven by
a `changeRequest` string (review findings OR the user's comment text). Claude
commits locally; orchestrator owns push. Returns `{ ok, summary }`.

- [ ] **Step 1: Write the failing test**

Create `test/stages-prFix.test.js`:

```javascript
// test/stages-prFix.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPrFix, buildPrFixPrompt } from "../src/stages/prFix.js";

test("buildPrFixPrompt embeds the change request and TDD/baseline + constraints", () => {
  const p = buildPrFixPrompt("Use Turkish chars: Yorumlarınız");
  assert.match(p, /Yorumlarınız/);
  assert.match(p, /TDD|test-driven/i);
  assert.match(p, /BASELINE PROTOCOL/);
  assert.match(p, /DO NOT run `gh`/);
  assert.match(p, /<<<RESULT/);
});

test("runPrFix returns ok when gate passes", async () => {
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"noNewFailures":true,"changeTestsPass":true,"summary":"fixed copy"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const r = await runPrFix({
    claude, cwd: "/wt", changeRequest: "fix it", timeoutMs: 10,
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /fixed copy/);
});

test("runPrFix returns ok:false with summary when gate not green", async () => {
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"noNewFailures":false,"changeTestsPass":true,"summary":"introduced lint error"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const r = await runPrFix({ claude, cwd: "/wt", changeRequest: "x", timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /introduced lint error/);
});

test("runPrFix throws on claude non-zero exit", async () => {
  const claude = { run: async () => ({ code: 1, stdout: "", stderr: "nope" }) };
  await assert.rejects(
    () => runPrFix({ claude, cwd: "/wt", changeRequest: "x", timeoutMs: 10 }),
    /pr-fix: claude exited 1/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stages-prFix.test.js`
Expected: FAIL — cannot import `../src/stages/prFix.js`.

- [ ] **Step 3: Implement the stage**

Create `src/stages/prFix.js`:

```javascript
// src/stages/prFix.js
import { parseResultBlock } from "./parse.js";

export function buildPrFixPrompt(changeRequest) {
  return `Apply the requested change to the OPEN pull request in this worktree
using strict TDD (superpowers test-driven-development): failing test first,
minimal code, refactor. Detect and run the project's own
test/lint/typecheck/build commands.

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Pushing or creating a PR yourself is a hard error.

BASELINE PROTOCOL (mandatory — gate is baseline-relative, NOT whole-repo-green):
1. Before changing code, run the project's test/lint/typecheck/build on the UNMODIFIED tree and record pre-existing failures.
2. Implement ONLY the requested change with strict TDD. NEVER fix unrelated pre-existing failures.
3. Re-run the same commands; use \`git stash\` to compare before/after if needed.
4. The bar to pass: (a) tests covering your change PASS; (b) ZERO new test/lint/typecheck/build failures vs baseline.
5. Commit locally only.

CHANGE REQUEST:
${changeRequest}

Output ONLY this block at the end:
<<<RESULT
{"noNewFailures":true|false,"changeTestsPass":true|false,"summary":"<what you did / why blocked>"}
RESULT>>>`;
}

export async function runPrFix({ claude, cwd, changeRequest, timeoutMs, signal }) {
  const res = await claude.run({
    cwd,
    prompt: buildPrFixPrompt(changeRequest),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("pr-fix: cancelled");
  if (res.timedOut) throw new Error("pr-fix: timed out");
  if (res.code !== 0)
    throw new Error(`pr-fix: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  const ok = parsed.noNewFailures === true && parsed.changeTestsPass === true;
  return { ok, summary: parsed.summary || "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/stages-prFix.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stages/prFix.js test/stages-prFix.test.js
git commit -m "feat(stages): add runPrFix change-request stage"
```

---

## Task 7: `createPrReview` orchestration — core `tick()`

**Files:**
- Create: `src/prReview.js`
- Test: `test/prReview.test.js`

`createPrReview({ db, gh, workspace, stages, claude, config })` returns
`{ tick }`. `stages` provides `runPrReview`, `runPrFix`. The bot login is
resolved once per process: `config.botLogin` if non-empty, else memoized
`await gh.viewer()` (best-effort; on throw, treat as `""` so all authored
comments count as user comments — fail open toward responsiveness).

Algorithm per the spec's `tick()` section. PR number comes from
`gh.prStatus(...).number`. Comment "newer than watermark" compares `createdAt`
strings with `>`.

- [ ] **Step 1: Write the failing tests**

Create `test/prReview.test.js`:

```javascript
// test/prReview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createPrReview } from "../src/prReview.js";

const CAP_MARKER = "pr-review: iteration cap reached";

function seed(db, over = {}) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  const cols = {
    project_id: 1, issue_number: 8, state: "pr_open", branch: "claude/8-o-r",
    worktree_path: "/wt", pr_url: "https://github.com/o/r/pull/8",
    attempt: 1, created_at: "t", updated_at: "t",
    pr_phase: null, pr_reviewed_diff_id: null, pr_review_iterations: 0,
    pr_last_comment_at: null, needs_attention: 0, attention_reason: null,
    ...over,
  };
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO runs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
  ).run(...keys.map((k) => cols[k]));
  return db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
}

function baseDeps(over = {}) {
  return {
    gh: {
      prStatus: async () => ({ state: "OPEN", number: 8 }),
      prComments: async () => [],
      prComment: async () => {},
      viewer: async () => "bot",
      ...over.gh,
    },
    workspace: {
      diffFingerprint: async () => "fp1",
      pushBranch: async () => {},
      runExclusive: (_p, fn) => fn(),
      ...over.workspace,
    },
    config: { prReviewMaxIterations: 4, stageTimeoutMs: 10, botLogin: "bot" },
  };
}

test("first open, reviewing phase, changes-requested under cap -> fix + push + iter++", async () => {
  const db = openDb(":memory:");
  seed(db);
  let fixed = false, pushed = false;
  const d = baseDeps();
  const stages = {
    runPrReview: async () => ({ verdict: "changes-requested", findings: ["f"], notes: "n" }),
    runPrFix: async () => { fixed = true; return { ok: true, summary: "did it" }; },
  };
  d.workspace.pushBranch = async () => { pushed = true; };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  assert.equal(fixed, true);
  assert.equal(pushed, true);
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.pr_review_iterations, 1);
  assert.equal(r.pr_phase, "reviewing");
});

test("approve -> waiting_user + one summary comment + diff id recorded", async () => {
  const db = openDb(":memory:");
  seed(db);
  let comments = 0;
  const d = baseDeps();
  d.gh.prComment = async () => { comments += 1; };
  const stages = {
    runPrReview: async () => ({ verdict: "approve", findings: [], notes: "ok" }),
    runPrFix: async () => assert.fail("should not fix on approve"),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.pr_phase, "waiting_user");
  assert.equal(r.pr_reviewed_diff_id, "fp1");
  assert.equal(comments, 1);
  // second tick, nothing changed -> no-op, no extra comment
  await pr.tick();
  assert.equal(comments, 1);
});

test("cap reached -> needs_attention + findings comment, no fix", async () => {
  const db = openDb(":memory:");
  seed(db, { pr_review_iterations: 4, pr_phase: "reviewing" });
  let body = "";
  const d = baseDeps();
  d.gh.prComment = async (_r, _n, b) => { body = b; };
  const stages = {
    runPrReview: async () => ({ verdict: "changes-requested", findings: ["still bad"], notes: "n" }),
    runPrFix: async () => assert.fail("must not fix past cap"),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 1);
  assert.match(r.attention_reason, /iteration cap/);
  assert.equal(r.pr_phase, "waiting_user");
  assert.match(body, /still bad/);
});

test("new user comment -> fix + reply + counter reset + re-enter reviewing", async () => {
  const db = openDb(":memory:");
  seed(db, { pr_phase: "waiting_user", pr_review_iterations: 3, pr_reviewed_diff_id: "fp1",
             pr_last_comment_at: "2026-05-17T09:00:00Z" });
  let replied = false, pushed = false;
  const d = baseDeps();
  d.gh.prComments = async () => [
    { id: "C1", author: { login: "talhabera" }, body: "use Turkish chars", createdAt: "2026-05-17T10:00:00Z" },
  ];
  d.gh.prComment = async () => { replied = true; };
  d.workspace.pushBranch = async () => { pushed = true; };
  const stages = {
    runPrReview: async () => assert.fail("comment path must not review first"),
    runPrFix: async () => ({ ok: true, summary: "applied comment" }),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(pushed, true);
  assert.equal(replied, true);
  assert.equal(r.pr_review_iterations, 0);
  assert.equal(r.pr_phase, "reviewing");
  assert.equal(r.pr_reviewed_diff_id, null);
  assert.equal(r.pr_last_comment_at, "2026-05-17T10:00:00Z");
});

test("bot's own comment is ignored (no work)", async () => {
  const db = openDb(":memory:");
  seed(db, { pr_phase: "waiting_user", pr_reviewed_diff_id: "fp1" });
  const d = baseDeps();
  d.gh.prComments = async () => [
    { id: "C9", author: { login: "bot" }, body: "✅ automated review passed", createdAt: "2026-05-17T11:00:00Z" },
  ];
  const stages = {
    runPrReview: async () => assert.fail("no review expected"),
    runPrFix: async () => assert.fail("no fix expected"),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick(); // must be a no-op
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.pr_phase, "waiting_user");
});

test("PR not OPEN -> skipped entirely", async () => {
  const db = openDb(":memory:");
  seed(db);
  const d = baseDeps();
  d.gh.prStatus = async () => ({ state: "MERGED", number: 8 });
  const stages = {
    runPrReview: async () => assert.fail("no review on closed PR"),
    runPrFix: async () => assert.fail("no fix on closed PR"),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  assert.ok(true);
});

test("waiting_user, no new comment, unchanged diff -> pure no-op", async () => {
  const db = openDb(":memory:");
  seed(db, { pr_phase: "waiting_user", pr_reviewed_diff_id: "fp1" });
  const d = baseDeps();
  let calls = 0;
  const stages = {
    runPrReview: async () => { calls++; return { verdict: "approve" }; },
    runPrFix: async () => { calls++; return { ok: true }; },
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  assert.equal(calls, 0);
});

test("review-cap needs_attention cleared by a new user comment; rebase-conflict left intact", async () => {
  // case A: cap marker cleared
  let db = openDb(":memory:");
  seed(db, { pr_phase: "waiting_user", needs_attention: 1,
             attention_reason: "pr-review: iteration cap reached (4)",
             pr_last_comment_at: "2026-05-17T09:00:00Z" });
  let d = baseDeps();
  d.gh.prComments = async () => [
    { id: "C1", author: { login: "talhabera" }, body: "try again", createdAt: "2026-05-17T10:00:00Z" },
  ];
  let stages = {
    runPrReview: async () => assert.fail("comment path first"),
    runPrFix: async () => ({ ok: true, summary: "s" }),
  };
  let pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  let r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 0);

  // case B: rebase-conflict needs_attention NOT touched (run skipped while flagged)
  db = openDb(":memory:");
  seed(db, { pr_phase: "waiting_user", needs_attention: 1,
             attention_reason: "rebase-resolve: semantic conflict" });
  d = baseDeps();
  d.gh.prComments = async () => [
    { id: "C2", author: { login: "talhabera" }, body: "ping", createdAt: "2026-05-17T10:00:00Z" },
  ];
  stages = {
    runPrReview: async () => assert.fail("skip while attention"),
    runPrFix: async () => assert.fail("skip while attention"),
  };
  pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config });
  await pr.tick();
  r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 1);
  assert.match(r.attention_reason, /rebase-resolve/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/prReview.test.js`
Expected: FAIL — cannot import `../src/prReview.js`.

- [ ] **Step 3: Implement `src/prReview.js`**

Create `src/prReview.js`:

```javascript
// src/prReview.js
const CAP_MARKER = "pr-review: iteration cap reached";

export function createPrReview({ db, gh, workspace, stages, claude, config }) {
  let botLoginCache;

  async function resolveBotLogin() {
    if (config.botLogin) return config.botLogin;
    if (botLoginCache !== undefined) return botLoginCache;
    try {
      botLoginCache = await gh.viewer();
    } catch {
      botLoginCache = "";
    }
    return botLoginCache;
  }

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
          // Never let one PR break the sweep; surface via attention only if
          // not already a distinct (rebase-conflict) attention flag.
          db.prepare(
            "UPDATE runs SET updated_at=datetime('now') WHERE id=?",
          ).run(r.id);
          // eslint-disable-next-line no-console
          console.error(`prReview run ${r.id}: ${e.message}`);
        }
      }
    }
  }

  async function handleRun(p, r) {
    if (!r.worktree_path) return; // manual / cleaned up

    const isReviewCapAttention =
      r.needs_attention === 1 &&
      typeof r.attention_reason === "string" &&
      r.attention_reason.startsWith(CAP_MARKER);
    // A non-review-cap needs_attention (e.g. rebase conflict) is a distinct
    // concern owned elsewhere — skip this run entirely while it is flagged.
    if (r.needs_attention === 1 && !isReviewCapAttention) return;

    let status;
    try {
      status = await gh.prStatus(p.repo, r.branch);
    } catch {
      return;
    }
    if (!status || status.state !== "OPEN") return; // poller owns cleanup
    const prNumber = status.number;

    const botLogin = await resolveBotLogin();
    const comments = (await gh.prComments(p.repo, r.branch)) || [];
    const watermark = r.pr_last_comment_at || "";
    const newUserComments = comments
      .filter(
        (c) =>
          c &&
          c.author &&
          c.author.login !== botLogin &&
          (c.createdAt || "") > watermark,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    return workspace.runExclusive(p, async () => {
      // --- Path A: new user comment(s) take priority ---
      if (newUserComments.length > 0) {
        const newest = newUserComments[newUserComments.length - 1].createdAt;
        const changeRequest = newUserComments
          .map((c) => `- ${c.body}`)
          .join("\n");
        const fix = await stages.runPrFix({
          claude,
          cwd: r.worktree_path,
          changeRequest: `User review comments to address:\n${changeRequest}`,
          timeoutMs: config.stageTimeoutMs,
        });
        await workspace.pushBranch(p, r.worktree_path, r.branch);
        await gh.prComment(
          p.repo,
          prNumber,
          fix.ok
            ? `Addressed your comment(s): ${fix.summary}`
            : `Attempted your comment(s) but the change gate did not pass: ${fix.summary}`,
        );
        db.prepare(
          `UPDATE runs SET pr_last_comment_at=?, pr_review_iterations=0,
             pr_reviewed_diff_id=NULL, pr_phase='reviewing',
             needs_attention=CASE WHEN ? THEN 0 ELSE needs_attention END,
             attention_reason=CASE WHEN ? THEN NULL ELSE attention_reason END,
             updated_at=datetime('now')
           WHERE id=?`,
        ).run(newest, isReviewCapAttention ? 1 : 0, isReviewCapAttention ? 1 : 0, r.id);
        return;
      }

      // --- Path B: review loop (only when there are new commits) ---
      const fingerprint = await workspace.diffFingerprint(p, r.worktree_path);
      if ((r.pr_phase || "reviewing") === "waiting_user" &&
          r.pr_reviewed_diff_id === fingerprint) {
        return; // idempotent no-op: nothing new, genuinely waiting
      }
      if (r.pr_reviewed_diff_id === fingerprint &&
          (r.pr_phase || "reviewing") !== "reviewing") {
        return;
      }

      const review = await stages.runPrReview({
        db,
        run: r,
        claude,
        cwd: r.worktree_path,
        base: p.base_branch || "main",
        timeoutMs: config.stageTimeoutMs,
      });

      if (review.verdict === "approve") {
        db.prepare(
          `UPDATE runs SET pr_phase='waiting_user', pr_reviewed_diff_id=?,
             updated_at=datetime('now') WHERE id=?`,
        ).run(fingerprint, r.id);
        await gh.prComment(
          p.repo,
          prNumber,
          "✅ automated review passed — waiting for your comments.",
        );
        return;
      }

      // changes-requested
      const iterations = r.pr_review_iterations || 0;
      if (iterations >= config.prReviewMaxIterations) {
        const findings = (review.findings || []).map((f) => `- ${f}`).join("\n");
        db.prepare(
          `UPDATE runs SET pr_phase='waiting_user', needs_attention=1,
             attention_reason=?, pr_reviewed_diff_id=?,
             updated_at=datetime('now') WHERE id=?`,
        ).run(
          `${CAP_MARKER} (${config.prReviewMaxIterations})`,
          fingerprint,
          r.id,
        );
        await gh.prComment(
          p.repo,
          prNumber,
          `Automated review hit the ${config.prReviewMaxIterations}-iteration cap. Remaining findings — waiting for your guidance:\n${findings}`,
        );
        return;
      }

      const fix = await stages.runPrFix({
        claude,
        cwd: r.worktree_path,
        changeRequest:
          `Address these code-review findings:\n` +
          (review.findings || []).map((f) => `- ${f}`).join("\n") +
          (review.notes ? `\n\nReviewer notes: ${review.notes}` : ""),
        timeoutMs: config.stageTimeoutMs,
      });
      await workspace.pushBranch(p, r.worktree_path, r.branch);
      db.prepare(
        `UPDATE runs SET pr_review_iterations=?, pr_phase='reviewing',
           pr_reviewed_diff_id=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(iterations + 1, r.id);
      // intentionally do not record fix.ok in DB — next tick re-reviews the
      // new diff; a non-ok fix still surfaces via the next review verdict.
      void fix;
    });
  }

  return { tick };
}
```

> Note on the fake `workspace.runExclusive` in tests: the real
> `src/workspace.js` exposes `runExclusive(project, fn)` (verified present).
> Tests provide `runExclusive: (_p, fn) => fn()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/prReview.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/prReview.js test/prReview.test.js
git commit -m "feat(prReview): orchestrate review/fix/comment loop for cdev PRs"
```

---

## Task 8: Wire into `buildAutonomous`

**Files:**
- Modify: `src/wire.js`
- Test: `test/server-wiring.test.js`

- [ ] **Step 1: Extend the wiring test (failing)**

In `test/server-wiring.test.js`, add an assertion to the existing test body
after `assert.ok(a.prSweep);`:

```javascript
  assert.ok(a.prReview, "prReview not wired");
  assert.equal(typeof a.prReview.tick, "function");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-wiring.test.js`
Expected: FAIL — `prReview not wired`.

- [ ] **Step 3: Wire it**

In `src/wire.js`:

Add imports near the other stage/component imports:

```javascript
import { createPrReview } from "./prReview.js";
import { runPrReview } from "./stages/prReview.js";
import { runPrFix } from "./stages/prFix.js";
```

Add `runPrReview` and `runPrFix` into the existing `stages` object:

```javascript
  const stages = {
    claude,
    runSpecPlan,
    runImplement,
    runReview,
    runPr,
    runResolveConflict,
    runPrReview,
    runPrFix,
  };
```

After the `const prSweep = createPrSweep({ ... });` line, add:

```javascript
  const prReview = createPrReview({
    db, gh, workspace, stages, claude, config,
  });
```

Add `prReview` to the returned object:

```javascript
  return { config, db, projects, workspace, executor, scheduler, poller, prSweep, prReview, mount };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-wiring.test.js`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/wire.js test/server-wiring.test.js
git commit -m "feat(wire): construct and expose prReview from buildAutonomous"
```

---

## Task 9: Server interval + startup log

**Files:**
- Modify: `server.js`

No unit test (server bootstrap is integration-level; `server-wiring.test.js`
already covers construction). Verified manually in Task 10.

- [ ] **Step 1: Add the interval**

In `server.js`, after the existing `setInterval(... autonomous.prSweep.tick() ..., autonomous.config.prSyncMs)` block, add:

```javascript
setInterval(
  () =>
    autonomous.prReview
      .tick()
      .catch((e) => console.error("prReview err:", e.message)),
  autonomous.config.prReviewMs,
).unref();
```

- [ ] **Step 2: Extend the startup log line**

Change the existing `autonomous-dev wired:` console.log to append `prReview`:

```javascript
console.log(
  `autonomous-dev wired: poll=${autonomous.config.issuePollMs}ms prSync=${autonomous.config.prSyncMs}ms prReview=${autonomous.config.prReviewMs}ms maxRuns=${autonomous.config.maxConcurrentRuns}`,
);
```

- [ ] **Step 3: Syntax-check the server boots offline**

Run: `DB_PATH=:memory: node -e "import('./src/wire.js').then(m=>{const a=m.buildAutonomous({env:{DB_PATH:':memory:'}});console.log('ok', typeof a.prReview.tick)})"`
Expected: prints `ok function`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(server): drive prReview on prReviewMs interval + startup log"
```

---

## Task 10: Full verification + service restart

**Files:** none (operational).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all green, including every new file. Capture the summary line.

- [ ] **Step 2: Confirm no merge capability leaked in**

Run: `grep -rn "pr merge\|--merge\|gh pr merge" src/ server.js`
Expected: NO matches (the bot must be structurally incapable of merging).

- [ ] **Step 3: Restart the service (no hot-reload)**

Run: `systemctl --user restart headless-claude.service`
Then: `journalctl --user -u headless-claude.service -n 20 --no-pager | grep "autonomous-dev wired"`
Expected: a line containing `prReview=120000ms`.

- [ ] **Step 4: Smoke-check against the live PR (#36)**

The acme-web project already has an open cdev PR (#36, run id 3,
`state=pr_open`). Within ~2 minutes (`prReviewMs`), confirm the loop engaged:

Run: `node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/claude-projects/autonomous/autonomous.db');console.log(db.prepare('SELECT id,issue_number,state,pr_phase,pr_review_iterations,pr_reviewed_diff_id,needs_attention FROM runs WHERE state=\"pr_open\"').all())"`
Expected: run 3 shows a non-null `pr_phase` (either `reviewing` mid-loop or
`waiting_user` once it has reviewed/acted), confirming `tick()` ran end-to-end
against real GitHub.

- [ ] **Step 5: Final commit (plan completion marker)**

```bash
git add -A
git commit -m "chore: cdev PR review watcher — verified end-to-end" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Architecture (new module, sibling, interval after prSweep) → Tasks 7, 9 ✅
- Scope only `state='pr_open'` cdev PRs → Task 7 query ✅
- Re-review→fix→push until approve → Task 7 Path B ✅
- Cap at 4 then findings comment + needs_attention + wait → Task 7 + test ✅
- New user comment → fix + push + reply + reset + re-enter reviewing → Task 7 Path A + test ✅
- Never merge → Task 10 Step 2 grep gate ✅
- Idempotent no-op while waiting → Task 7 + test ✅
- 4 idempotent `runs` columns → Task 1 ✅
- Config keys (`prReviewMs`, `prReviewMaxIterations`, `botLogin`/`PR_BOT_LOGIN`) → Task 2 ✅
- gh `prComments`/`prComment`/`viewer` → Task 3 ✅
- Rebase-stable diff fingerprint (`git patch-id`) → Task 4 ✅
- `runPrReview` (code-review rigor, PIPELINE CONSTRAINTS, artifact) → Task 5 ✅
- `runPrFix` (baseline/TDD, PIPELINE CONSTRAINTS) → Task 6 ✅
- Bot-comment exclusion via resolved login (env or lazy `gh.viewer()`) → Task 7 ✅
- Review-cap attention cleared by user comment; rebase-conflict attention left intact → Task 7 + test ✅
- Worktree mutex (`runExclusive`) wrapping stage work → Task 7 ✅
- Restart + startup log verification → Tasks 9, 10 ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step has full code. Two explicit verification notes (mutex `lock` shape in Task 4; `git` stdin passthrough in Task 4) are bounded investigations with a concrete fallback, not placeholders.

**Type/name consistency:** `createPrReview({db,gh,workspace,stages,claude,config})` and `{tick}` consistent across Tasks 7–9. Stage signatures: `runPrReview({db,run,claude,cwd,base,timeoutMs,signal})` (Task 5) matches the call in Task 7. `runPrFix({claude,cwd,changeRequest,timeoutMs,signal})` (Task 6) matches Task 7 calls. Columns `pr_phase`/`pr_reviewed_diff_id`/`pr_review_iterations`/`pr_last_comment_at` identical across Tasks 1, 7, tests. `CAP_MARKER` string identical in `src/prReview.js` and the test file. gh `prComment(repo, prNumber, body)` signature consistent (Task 3 ↔ Task 7).
