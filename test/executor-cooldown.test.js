// test/executor-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createExecutor } from "../src/executor.js";

const CFG = {
  stageTimeoutMs: 1000,
  runCooldownMs: 180_000,
  runCooldownMaxMs: 3_600_000,
  keepFailedWorktree: false,
};

function seedQueued(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(11,1,77,'queued',1,'t','t')",
  ).run();
}

test("executor failure path records cooldown failure", async () => {
  const db = openDb(":memory:");
  seedQueued(db);
  const executor = createExecutor({
    db,
    gh: { issue: async () => { throw new Error("gh down"); }, swapLabel: async () => {}, comment: async () => {} },
    workspace: { prepareClone: async () => "sha", addWorktree: async () => ({ path: "/tmp/wt", branch: "claude/77-p" }), removeWorktree: async () => {} },
    stages: { claude: {} },
    decompose: async () => {},
    config: CFG,
    git: () => ({ code: 0, stdout: "", stderr: "" }),
    preview: { maybeDeployPreview: async () => {} },
    runLock: createKeyedMutex(),
  });
  await executor.execute(11);
  const r = db.prepare("SELECT state, consecutive_failures FROM runs WHERE id=11").get();
  assert.equal(r.state, "failed");
  assert.equal(r.consecutive_failures, 1);
});
