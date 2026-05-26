// test/executor-cancel.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";
import { createKeyedMutex } from "../src/mutex.js";

const COOLDOWN = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };

function base(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/clones/o-r','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
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

test("cancel while stage is in-flight fails run with reason 'cancelled by user'", async () => {
  const db = openDb(":memory:");
  const run = base(db);

  const stages = {
    // runSpecPlan holds until signal fires, then rejects
    runSpecPlan: async (args) => {
      return new Promise((_resolve, reject) => {
        if (args.signal && args.signal.aborted) {
          reject(new Error("spec_plan: cancelled"));
          return;
        }
        args.signal.addEventListener("abort", () => {
          reject(new Error("spec_plan: cancelled"));
        });
      });
    },
  };

  const ex = createExecutor({
    db, gh, workspace: ws, stages,
    config: { stageTimeoutMs: 10000, ...COOLDOWN },
    runLock: createKeyedMutex(),
  });

  // start execute without awaiting
  const execPromise = ex.execute(run.id);

  // give the execute a tick to get into runSpecPlan
  await new Promise((r) => setImmediate(r));

  // cancel
  ex.cancel(run.id);

  // now await execute
  await execPromise;

  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.equal(r.fail_reason, "cancelled by user");

  // active map cleared after execute resolved: a second cancel is non-active path
  const second = ex.cancel(run.id);
  assert.equal(second.killed, false);
});

test("cancel for non-active queued run sets state failed with reason 'cancelled by user'", async () => {
  const db = openDb(":memory:");
  base(db); // run id=1 is 'queued', never executed

  const ex = createExecutor({
    db, gh, workspace: ws, stages: {},
    config: { stageTimeoutMs: 10000, ...COOLDOWN },
    runLock: createKeyedMutex(),
  });

  const result = ex.cancel(1);

  assert.equal(result.cancelled, true);
  assert.equal(result.killed, false);

  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.equal(r.fail_reason, "cancelled by user");
});

test("cancel between stages (during prepareClone) still fails the run with 'cancelled by user'", async () => {
  const db = openDb(":memory:");
  const run = base(db);

  const workspace = {
    prepareClone: () => new Promise(() => {}), // never resolves
    addWorktree: async () => ({ path: "/wt/o-r-8-1", branch: "claude/8-o-r" }),
    removeWorktree: async () => {},
    rebaseOnBase: async () => ({ conflicted: false }),
  };
  const stages = {
    runSpecPlan: async () => ({}),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve", notes: "", checklist: [] }),
    runPr: async () => ({ prUrl: "u" }),
  };

  const ex = createExecutor({
    db, gh, workspace, stages,
    config: { stageTimeoutMs: 10000, ...COOLDOWN },
    runLock: createKeyedMutex(),
  });

  const p = ex.execute(run.id); // do not await — stuck in prepareClone
  await new Promise((r) => setTimeout(r, 20));
  ex.cancel(run.id);
  await p;

  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.equal(r.fail_reason, "cancelled by user");
});
