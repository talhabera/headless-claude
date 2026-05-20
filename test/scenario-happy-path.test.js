// test/scenario-happy-path.test.js
// Operator labels a single issue → bot develops it → PR opens.
// Verifies the throttles (semaphore + pacing + cooldown) don't break the healthy path.
import { test } from "node:test";
import assert from "node:assert/strict";

import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createExecutor } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import { createPoller } from "../src/poller.js";

test("S1: single labeled issue → pr_open", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();

  const gh = {
    listLabeledIssues: async () => [{ number: 100, title: "feat", body: "go" }],
    swapLabel: async () => {},
    setLabel: async () => {},
    comment: async () => {},
    issue: async () => ({ number: 100, title: "feat", body: "go", state: "OPEN" }),
  };

  // Mock workspace — avoids real git calls
  const workspace = {
    prepareClone: async () => "sha123",
    addWorktree: async () => ({ path: "/wt/100", branch: "claude/100-o-r" }),
    rebaseOnBase: async () => ({ conflicted: false }),
    removeWorktree: async () => {},
  };

  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve" }),
    runPr: async ({ db, run }) => {
      db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run("https://example/pr/1", run.id);
      return { prUrl: "https://example/pr/1" };
    },
  };

  const config = {
    stageTimeoutMs: 10,
    prReviewMaxIterations: 4,
    runCooldownMs: 180_000,
    runCooldownMaxMs: 3_600_000,
    keepFailedWorktree: false,
  };

  const executor = createExecutor({
    db, gh, workspace, stages, decompose: async () => {},
    config,
    git: null, // not used — workspace is mocked
    preview: { maybeDeployPreview: async () => {} },
    runLock: createKeyedMutex(),
  });
  const scheduler = createScheduler({ db, executor, maxConcurrentRuns: 2 });
  const poller = createPoller({ db, gh, workspace });

  await poller.tick();
  await scheduler.drain();

  const run = db.prepare("SELECT * FROM runs WHERE issue_number=100").get();
  assert.ok(run, "run row must exist");
  assert.equal(run.state, "pr_open", `expected pr_open, got ${run.state} (fail_reason: ${run.fail_reason})`);
  assert.equal(run.consecutive_failures, 0, "successful run has 0 consecutive_failures");
  assert.ok(run.next_attempt_at, "successful run should have next_attempt_at set for cooldown");
});
