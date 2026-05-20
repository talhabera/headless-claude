// test/integration.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import { createPoller } from "../src/poller.js";
import { reconcileOnStartup } from "../src/reconcile.js";
import { createKeyedMutex } from "../src/mutex.js";

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
    config: { stageTimeoutMs: 10, runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 },
    runLock: createKeyedMutex(),
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
