// test/api.test.js
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

test("POST /projects registers", async () => {
  const db = openDb(":memory:");
  const projects = {
    register: async (a) => ({ slug: "o-r", repo: a.repo }),
    list: () => [],
  };
  const app = appWith(db, { projects });
  const r = await call(app, "POST", "/projects", {
    repo: "o/r", watchLabel: "claude-dev", baseBranch: "main",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.slug, "o-r");
});

test("GET /runs lists rows", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  const app = appWith(db, {});
  const r = await call(app, "GET", "/runs");
  assert.equal(r.status, 200);
  assert.equal(r.json.runs.length, 1);
  assert.equal(r.json.runs[0].issue_number, 8);
});

test("POST /runs/:id/retry inserts a new attempt", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'failed',1,'t','t')",
  ).run();
  const app = appWith(db, {});
  const r = await call(app, "POST", "/runs/1/retry");
  assert.equal(r.status, 200);
  const fresh = db
    .prepare("SELECT * FROM runs WHERE issue_number=8 AND attempt=2")
    .get();
  assert.equal(fresh.state, "queued");
});
