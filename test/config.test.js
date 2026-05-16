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
