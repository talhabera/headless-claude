// test/implement.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runImplement } from "../src/stages/implement.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,3,'implementing',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO run_artifacts (run_id,kind,content) VALUES (1,'plan','PLAN')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("green gate passes when claude reports allGreen", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"allGreen":true,"summary":"implemented per plan"}
RESULT>>>`,
    }),
  };
  const r = await runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.allGreen, true);
});

test("gate fails when not green", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"allGreen":false,"summary":"3 failing tests"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 }),
    /implement: gate not green: 3 failing tests/,
  );
});
