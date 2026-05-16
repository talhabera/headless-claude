// test/db.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";

test("openDb creates all tables", () => {
  const db = openDb(":memory:");
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(names, [
    "issue_deps",
    "projects",
    "run_artifacts",
    "run_logs",
    "runs",
  ]);
});

test("runs unique constraint on (project_id, issue_number, attempt)", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  const ins = db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,7,'queued',1,'t','t')",
  );
  ins.run();
  assert.throws(() => ins.run(), /UNIQUE/);
});
