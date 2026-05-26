// test/state.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { LABEL_FOR, transition, TERMINAL } from "../src/state.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,5,'queued',1,'t','t')",
  ).run();
  return 1;
}

test("label mapping covers every reachable state", () => {
  for (const s of [
    "queued", "spec_plan", "implementing", "reviewing",
    "pr_open", "merged", "failed",
  ]) {
    assert.ok(LABEL_FOR[s], `missing label for ${s}`);
  }
  assert.equal(LABEL_FOR.queued, "in-progress");
  assert.equal(LABEL_FOR.pr_open, "pr-open");
});

test("transition updates state and writes a log row", () => {
  const db = openDb(":memory:");
  const id = seed(db);
  transition(db, id, "spec_plan", { stage: "spec_plan", message: "started" });
  const run = db.prepare("SELECT state FROM runs WHERE id=?").get(id);
  assert.equal(run.state, "spec_plan");
  const log = db
    .prepare("SELECT * FROM run_logs WHERE run_id=? ORDER BY id DESC")
    .get(id);
  assert.equal(log.message, "started");
  assert.equal(log.stage, "spec_plan");
});

test("TERMINAL set is correct", () => {
  assert.deepEqual(
    [...TERMINAL].sort(),
    ["failed", "merged", "pr_open"],
  );
});
