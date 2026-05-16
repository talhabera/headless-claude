// test/review.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runReview } from "../src/stages/review.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,3,'reviewing',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO run_artifacts (run_id,kind,content) VALUES (1,'spec','SPEC'),(1,'acceptance_checklist','[\"X\"]')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("approve returns verdict approve and stores it", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"verdict":"approve","checklist":[{"item":"X","met":true}],"notes":"lgtm"}
RESULT>>>`,
    }),
  };
  const r = await runReview({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.verdict, "approve");
  const a = db
    .prepare("SELECT content FROM run_artifacts WHERE run_id=1 AND kind='review_verdict'")
    .get();
  assert.match(a.content, /approve/);
});

test("changes-requested returned (executor decides looping)", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"verdict":"changes-requested","checklist":[{"item":"X","met":false}],"notes":"fix X"}
RESULT>>>`,
    }),
  };
  const r = await runReview({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.verdict, "changes-requested");
  assert.equal(r.notes, "fix X");
});
