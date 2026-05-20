// test/executor-preview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";
import { createKeyedMutex } from "../src/mutex.js";

const COOLDOWN = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base(db, { preview_branch = null, preview_url = null } = {}) {
  db.prepare(
    `INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,preview_branch,preview_url,created_at)
     VALUES ('o-r','o/r','/clones/o-r','claude-dev','main',?,?,'t')`,
  ).run(preview_branch, preview_url);
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  return {
    run: db.prepare("SELECT * FROM runs WHERE id=1").get(),
    project: db.prepare("SELECT * FROM projects WHERE id=1").get(),
  };
}

// Fake workspace — includes runExclusive so the executor can serialize preview ops
const ws = {
  prepareClone: async () => "sha0",
  addWorktree: async () => ({ path: "/wt/o-r-8-1", branch: "claude/8-o-r" }),
  removeWorktree: async () => {},
  rebaseOnBase: async () => ({ conflicted: false }),
  runExclusive: (p, fn) => fn(),
};

const gh = {
  issue: async () => ({ number: 8, title: "T", body: "B", state: "OPEN" }),
  comment: async () => {},
  swapLabel: async () => {},
  setLabel: async () => {},
  createPR: async () => ({ url: "https://github.com/o/r/pull/1" }),
};

const noopGit = () => ({ code: 0, stdout: "", stderr: "" });

// Build a minimal stages object; accepts optional runPr spy
function makeStages(runPrSpy) {
  let prCallCount = 0;
  const runPr = async ({ db, run }) => {
    prCallCount++;
    db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run("u", run.id);
    if (runPrSpy) runPrSpy(prCallCount);
    return { prUrl: "u" };
  };
  return {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve", notes: "", checklist: [] }),
    runPr,
    get prCallCount() { return prCallCount; },
  };
}

// ---------------------------------------------------------------------------
// Case 1: Happy preview — merge ok, poll ok
// ---------------------------------------------------------------------------
test("preview happy path: mergeToPreview ok + pollUrl ok → pr_open with live log", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  let mergeCalledWith = null;
  const preview = {
    mergeToPreview: async (args) => {
      mergeCalledWith = args;
      return { ok: true, previewBranch: "preprod" };
    },
    pollUrl: async () => ({ ok: true, status: 200, elapsedMs: 5 }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 5000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  await ex.execute(run.id);

  // Run must end in pr_open
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");

  // A previewing log must contain "preview live 200"
  const logs = db.prepare("SELECT * FROM run_logs WHERE run_id=1 AND stage='previewing'").all();
  assert.ok(logs.length > 0, "expected at least one previewing log");
  const liveLog = logs.find((l) => l.message && l.message.includes("preview live 200"));
  assert.ok(liveLog, `expected a log with 'preview live 200', got: ${JSON.stringify(logs)}`);

  // mergeToPreview must have been called with the run's branch
  assert.ok(mergeCalledWith, "mergeToPreview was not called");
  assert.equal(mergeCalledWith.runBranch, "claude/8-o-r");
});

// ---------------------------------------------------------------------------
// Case 2: Tolerant on merge fail — run still reaches pr_open
// ---------------------------------------------------------------------------
test("preview tolerant on merge fail: run still reaches pr_open with warn log", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  const preview = {
    mergeToPreview: async () => ({ ok: false, step: "update-preview", reason: "non-ff" }),
    pollUrl: async () => ({ ok: true, status: 200, elapsedMs: 5 }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 5000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  await ex.execute(run.id);

  // Still reaches pr_open
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");

  // A warn log mentioning "preview merge skipped"
  const logs = db.prepare("SELECT * FROM run_logs WHERE run_id=1 AND stage='previewing'").all();
  const warnLog = logs.find((l) => l.message && l.message.includes("preview merge skipped"));
  assert.ok(warnLog, `expected a log with 'preview merge skipped', got: ${JSON.stringify(logs)}`);

  // runPr must have been called
  assert.equal(stages.prCallCount, 1, "runPr should be called exactly once");
});

// ---------------------------------------------------------------------------
// Case 3: Tolerant on pollUrl not live — run still pr_open
// ---------------------------------------------------------------------------
test("preview tolerant on pollUrl not live: run still reaches pr_open with warn log", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  const preview = {
    mergeToPreview: async () => ({ ok: true, previewBranch: "preprod" }),
    pollUrl: async () => ({ ok: false, reason: "preview deploy not live within 5000ms" }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 5000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  await ex.execute(run.id);

  // Still reaches pr_open
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");

  // A warn log with "preview not confirmed"
  const logs = db.prepare("SELECT * FROM run_logs WHERE run_id=1 AND stage='previewing'").all();
  const warnLog = logs.find((l) => l.message && l.message.includes("preview not confirmed"));
  assert.ok(warnLog, `expected a log with 'preview not confirmed', got: ${JSON.stringify(logs)}`);
});

// ---------------------------------------------------------------------------
// Case 4: Tolerant on thrown error — run still pr_open
// ---------------------------------------------------------------------------
test("preview tolerant on thrown error: run still reaches pr_open with warn log", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  const preview = {
    mergeToPreview: async () => { throw new Error("network timeout"); },
    pollUrl: async () => ({ ok: true, status: 200, elapsedMs: 5 }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 5000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  await ex.execute(run.id);

  // Still reaches pr_open
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");

  // A warn log with "preview step error (tolerated)"
  const logs = db.prepare("SELECT * FROM run_logs WHERE run_id=1 AND stage='previewing'").all();
  const warnLog = logs.find((l) => l.message && l.message.includes("preview step error (tolerated)"));
  assert.ok(warnLog, `expected a log with 'preview step error (tolerated)', got: ${JSON.stringify(logs)}`);
});

// ---------------------------------------------------------------------------
// Case 5: Skipped when unconfigured — no previewing log, no merge call
// ---------------------------------------------------------------------------
test("preview skipped when project has no preview_branch/preview_url", async () => {
  const db = openDb(":memory:");
  const { run } = base(db); // no preview_branch, no preview_url

  let mergeCalled = false;
  const preview = {
    mergeToPreview: async () => { mergeCalled = true; return { ok: true }; },
    pollUrl: async () => ({ ok: true, status: 200, elapsedMs: 5 }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 5000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  await ex.execute(run.id);

  // Still reaches pr_open
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");

  // No previewing logs
  const logs = db.prepare("SELECT * FROM run_logs WHERE run_id=1 AND stage='previewing'").all();
  assert.equal(logs.length, 0, `expected no previewing logs, got: ${JSON.stringify(logs)}`);

  // mergeToPreview must NOT have been called
  assert.equal(mergeCalled, false, "mergeToPreview should not be called when unconfigured");
});

// ---------------------------------------------------------------------------
// Case 6 (regression / BUG 1+2): cancel during preview pollUrl →
// run fails 'cancelled by user', runPr NEVER called, state != pr_open
// ---------------------------------------------------------------------------
test("cancel during preview pollUrl → run fails 'cancelled by user', runPr NOT called", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  const preview = {
    mergeToPreview: async () => ({ ok: true, previewBranch: "preprod" }),
    // never settles — only raceAbort(ac, ...) can break this when cancel fires
    pollUrl: () => new Promise(() => {}),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 600000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  const p = ex.execute(run.id); // do not await — stuck in pollUrl
  await new Promise((r) => setTimeout(r, 20));
  ex.cancel(run.id);
  await p;

  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /cancelled by user/);
  assert.notEqual(r.state, "pr_open");

  // runPr must NEVER have been invoked on a cancelled run
  assert.equal(stages.prCallCount, 0, "runPr must NOT be called when cancelled during preview");
});

// ---------------------------------------------------------------------------
// Case 7 (regression / BUG 2 narrowness): cancel during preview mergeToPreview
// (slow push) → run fails 'cancelled by user', runPr NOT called
// ---------------------------------------------------------------------------
test("cancel during preview mergeToPreview → run fails 'cancelled by user', runPr NOT called", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  const preview = {
    // never settles — simulates a hung git push; raceAbort must break it on cancel
    mergeToPreview: () => new Promise(() => {}),
    pollUrl: async () => ({ ok: true, status: 200, elapsedMs: 5 }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 600000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  const p = ex.execute(run.id);
  await new Promise((r) => setTimeout(r, 20));
  ex.cancel(run.id);
  await p;

  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /cancelled by user/);
  assert.notEqual(r.state, "pr_open");
  assert.equal(stages.prCallCount, 0, "runPr must NOT be called when cancelled during merge");
});

// ---------------------------------------------------------------------------
// Case 8 (regression / BUG 2 not over-broadened): a NON-abort thrown error is
// STILL tolerated — run proceeds to pr_open (re-throw guard only catches aborts)
// ---------------------------------------------------------------------------
test("non-abort thrown error during preview is STILL tolerated → pr_open", async () => {
  const db = openDb(":memory:");
  const { run } = base(db, {
    preview_branch: "preprod",
    preview_url: "https://preview.example.com",
  });

  const preview = {
    mergeToPreview: async () => { throw new Error("git push: connection reset"); },
    pollUrl: async () => ({ ok: true, status: 200, elapsedMs: 5 }),
  };

  const stages = makeStages();
  const ex = createExecutor({
    db, gh, workspace: ws, stages, decompose: async () => {},
    config: { stageTimeoutMs: 10, previewDeployTimeoutMs: 5000, previewPollMs: 500, ...COOLDOWN },
    git: noopGit, preview,
    runLock: createKeyedMutex(),
  });

  await ex.execute(run.id);

  // Genuine infra error tolerated → still reaches pr_open
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");

  const logs = db.prepare("SELECT * FROM run_logs WHERE run_id=1 AND stage='previewing'").all();
  const warnLog = logs.find((l) => l.message && l.message.includes("preview step error (tolerated)"));
  assert.ok(warnLog, `expected a tolerated-error log, got: ${JSON.stringify(logs)}`);

  // runPr still invoked exactly once
  assert.equal(stages.prCallCount, 1, "runPr should still be called for tolerated infra errors");
});
