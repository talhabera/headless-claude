// test/scheduler-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createScheduler } from "../src/scheduler.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  // r1: eligible (no cooldown)
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(1,1,1,'queued',1,'t','t')",
  ).run();
  // r2: eligible (cooldown in the past)
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at,next_attempt_at) VALUES(2,1,2,'queued',1,'t','t','2020-01-01T00:00:00Z')",
  ).run();
  // r3: blocked (cooldown in the future)
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at,next_attempt_at) VALUES(3,1,3,'queued',1,'t','t','2099-01-01T00:00:00Z')",
  ).run();
}

test("scheduler skips runs whose next_attempt_at is in the future", async () => {
  const db = openDb(":memory:");
  seed(db);
  const executed = [];
  const fakeExecutor = {
    execute: async (id) => {
      executed.push(id);
      db.prepare("UPDATE runs SET state='pr_open' WHERE id=?").run(id);
    },
  };
  const sched = createScheduler({ db, executor: fakeExecutor, maxConcurrentRuns: 5 });
  await sched.drain();
  assert.deepEqual(executed.sort(), [1, 2]);
});
