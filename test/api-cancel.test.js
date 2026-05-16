// test/api-cancel.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../src/db.js";
import { mountApi } from "../src/api.js";

function appWith(db, deps) {
  const app = express();
  app.use(express.json());
  mountApi(app, { db, ...deps });
  return app;
}

async function call(app, method, path, body) {
  const server = app.listen(0);
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  server.close();
  return { status: res.status, json };
}

function seedRun(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
}

test("POST /runs/:id/cancel with executor calls executor.cancel with numeric id and returns {ok:true}", async () => {
  const db = openDb(":memory:");
  seedRun(db);

  let calledWith = null;
  const executor = {
    cancel: (id) => { calledWith = id; return { cancelled: true, killed: true }; },
  };

  const app = appWith(db, { executor });
  const r = await call(app, "POST", "/runs/1/cancel");

  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(calledWith, 1); // numeric, not string
});

test("POST /runs/:id/cancel returns 404 for missing run", async () => {
  const db = openDb(":memory:");

  const executor = {
    cancel: () => { throw new Error("should not be called"); },
  };

  const app = appWith(db, { executor });
  const r = await call(app, "POST", "/runs/999/cancel");

  assert.equal(r.status, 404);
  assert.equal(r.json.error, "no such run");
});
