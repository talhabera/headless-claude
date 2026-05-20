// test/prReview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrReview } from "../src/prReview.js";

const CAP_MARKER = "pr-review: iteration cap reached";

// Real on-disk dir so the production existsSync(worktree_path) guard passes
// for tests that exercise the work paths (path value is never asserted on).
const WT = mkdtempSync(join(tmpdir(), "prreview-wt-"));

function seed(db, over = {}) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  const cols = {
    project_id: 1, issue_number: 8, state: "pr_open", branch: "claude/8-o-r",
    worktree_path: WT, pr_url: "https://github.com/o/r/pull/8",
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
    config: { prReviewMaxIterations: 4, stageTimeoutMs: 10, botLogin: "bot", runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 },
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.pr_phase, "waiting_user");
  assert.equal(r.pr_reviewed_diff_id, "fp1");
  assert.equal(comments, 1);
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(pushed, true);
  assert.equal(replied, true);
  assert.equal(r.pr_review_iterations, 0);
  assert.equal(r.pr_phase, "reviewing");
  assert.equal(r.pr_reviewed_diff_id, null);
  assert.equal(r.pr_last_comment_at, "2026-05-17T10:00:00Z");
});

test("cold-start with only a bot comment: watermark baselined, phase preserved, no stage calls", async () => {
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.pr_phase, "waiting_user");
  assert.equal(r.pr_last_comment_at, "2026-05-17T11:00:00Z");
});

test("bot-authored newer comment is filtered out once watermark is set (no Path A)", async () => {
  const db = openDb(":memory:");
  seed(db, {
    pr_phase: "waiting_user",
    pr_reviewed_diff_id: "fp1",
    pr_last_comment_at: "2026-05-17T09:00:00Z",
  });
  const d = baseDeps();
  d.gh.prComments = async () => [
    { id: "B1", author: { login: "bot" }, body: "🤖 still working", createdAt: "2026-05-17T12:00:00Z" },
  ];
  const stages = {
    runPrReview: async () => assert.fail("bot comment must not trigger review"),
    runPrFix: async () => assert.fail("bot comment must not trigger fix"),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.pr_phase, "waiting_user");
  assert.equal(r.pr_last_comment_at, "2026-05-17T09:00:00Z");
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
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
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  assert.equal(calls, 0);
});

test("review-cap needs_attention cleared by a new user comment; rebase-conflict left intact", async () => {
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
  let pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  let r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 0);

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
  pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 1);
  assert.match(r.attention_reason, /rebase-resolve/);
});

test("worktree dir missing on disk -> needs_attention, no GitHub/stage calls", async () => {
  const db = openDb(":memory:");
  seed(db, { worktree_path: "/no/such/dir" });
  let prStatusCalled = false;
  const d = baseDeps();
  d.gh.prStatus = async () => { prStatusCalled = true; return { state: "OPEN", number: 8 }; };
  d.workspace.diffFingerprint = async () => assert.fail("must not fingerprint a missing worktree");
  const stages = {
    runPrReview: async () => assert.fail("no review on missing worktree"),
    runPrFix: async () => assert.fail("no fix on missing worktree"),
  };
  const pr = createPrReview({ db, gh: d.gh, workspace: d.workspace, stages, claude: {}, config: d.config, runLock: createKeyedMutex() });
  await pr.tick();
  const r = db.prepare("SELECT * FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 1);
  assert.match(r.attention_reason, /worktree missing/);
  assert.equal(prStatusCalled, false);
});
