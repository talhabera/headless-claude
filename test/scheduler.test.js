// test/scheduler.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createScheduler } from "../src/scheduler.js";

function seedRuns(db, n) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  for (let i = 1; i <= n; i++)
    db.prepare(
      "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,?, 'queued',1,'t','t')",
    ).run(i);
}

test("never exceeds maxConcurrentRuns; skips blocked", async () => {
  const db = openDb(":memory:");
  seedRuns(db, 5);
  db.prepare("UPDATE runs SET state='blocked' WHERE issue_number=3").run();
  let active = 0;
  let peak = 0;
  const executor = {
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    },
  };
  const sched = createScheduler({ db, executor, maxConcurrentRuns: 2 });
  await sched.drain();
  assert.equal(peak, 2);
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=3").get().state,
    "blocked",
  );
});

test("FIFO order by run id", async () => {
  const db = openDb(":memory:");
  seedRuns(db, 3);
  const order = [];
  const executor = {
    execute: async (id) => {
      order.push(id);
    },
  };
  const sched = createScheduler({ db, executor, maxConcurrentRuns: 1 });
  await sched.drain();
  assert.deepEqual(order, [1, 2, 3]);
});
