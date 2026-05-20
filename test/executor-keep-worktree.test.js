// test/executor-keep-worktree.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";
import { createKeyedMutex } from "../src/mutex.js";

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
    config: { stageTimeoutMs: 10, runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 },
    runLock: createKeyedMutex(),
  });
  await ex.execute(1);
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");
  assert.equal(removed, false);
});
