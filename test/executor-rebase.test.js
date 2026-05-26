// test/executor-rebase.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";
import { createKeyedMutex } from "../src/mutex.js";

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
    runSpecPlan: async () => ({}),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve", notes: "", checklist: [] }),
    runPr: async () => ({ prUrl: "u" }),
    runResolveConflict: async () => {
      resolveCalled++;
      return { resolved: true };
    },
  };
  const ex = createExecutor({
    db, gh, workspace, stages,
    config: { stageTimeoutMs: 10, runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 },
    runLock: createKeyedMutex(),
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
    runSpecPlan: async () => ({}),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve" }),
    runPr: async () => ({ prUrl: "u" }),
    runResolveConflict: async () => {
      throw new Error("rebase-resolve: semantic conflict");
    },
  };
  const ex = createExecutor({
    db, gh, workspace, stages,
    config: { stageTimeoutMs: 10, runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 },
    runLock: createKeyedMutex(),
  });
  await ex.execute(run.id);
  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /rebase-resolve/);
});
