// test/api-preview.test.js
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

test("POST /projects passes previewBranch and previewUrl to register", async () => {
  const db = openDb(":memory:");
  let capturedArg = null;
  const projects = {
    register: async (a) => {
      capturedArg = a;
      return { slug: "o-r", repo: a.repo, preview_branch: a.previewBranch, preview_url: a.previewUrl };
    },
    list: () => [],
  };
  const app = appWith(db, { projects });
  const r = await call(app, "POST", "/projects", {
    repo: "o/r",
    watchLabel: "claude-dev",
    baseBranch: "main",
    previewBranch: "preprod",
    previewUrl: "https://preprod.example.com",
  });
  assert.equal(r.status, 200);
  assert.equal(capturedArg.previewBranch, "preprod");
  assert.equal(capturedArg.previewUrl, "https://preprod.example.com");
});

test("POST /projects without preview fields still calls register and returns 200", async () => {
  const db = openDb(":memory:");
  let capturedArg = null;
  const projects = {
    register: async (a) => {
      capturedArg = a;
      return { slug: "o-r2", repo: a.repo };
    },
    list: () => [],
  };
  const app = appWith(db, { projects });
  const r = await call(app, "POST", "/projects", {
    repo: "o/r2",
    watchLabel: "claude-dev",
    baseBranch: "main",
  });
  assert.equal(r.status, 200);
  // previewBranch and previewUrl should be passed as undefined (not error)
  assert.equal(capturedArg.previewBranch, undefined);
  assert.equal(capturedArg.previewUrl, undefined);
});
