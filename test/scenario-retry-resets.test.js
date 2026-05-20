// test/scenario-retry-resets.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../src/db.js";
import { mountApi } from "../src/api.js";

test("S4: POST /runs/:id/retry creates a fresh attempt with cleared cooldown columns", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at,next_attempt_at,consecutive_failures) VALUES(51,1,62,'failed',1,'t','t','2099-01-01T00:00:00Z',19)",
  ).run();

  const app = express();
  app.use(express.json());
  mountApi(app, {
    db,
    projects: {},
    poller: { tick: async () => {} },
    scheduler: { tick: async () => {} },
    executor: { execute: async () => {}, cancel: () => {} },
  });

  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/runs/51/retry`, { method: "POST" });
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.attempt, 2);

    const fresh = db
      .prepare("SELECT * FROM runs WHERE issue_number=62 AND attempt=2")
      .get();
    assert.ok(fresh, "retry should create attempt=2");
    assert.equal(fresh.state, "queued");
    assert.equal(fresh.consecutive_failures, 0);
    assert.equal(fresh.next_attempt_at, null);
  } finally {
    server.close();
  }
});
