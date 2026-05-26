// test/specPlan.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runSpecPlan } from "../src/stages/specPlan.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,3,'spec_plan',1,'t','t')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("persists artifacts", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0,
      timedOut: false,
      stdout: `<<<RESULT
{"spec":"SPEC TEXT","plan":"PLAN TEXT",
"acceptanceChecklist":["does X","does Y"],"selfReviewPassed":true}
RESULT>>>`,
      stderr: "",
    }),
  };
  await runSpecPlan({
    db, run, claude,
    issue: { number: 3, title: "T", body: "B" },
    cwd: "/wt", timeoutMs: 1000,
  });
  const spec = db
    .prepare("SELECT content FROM run_artifacts WHERE run_id=1 AND kind='spec'")
    .get();
  assert.equal(spec.content, "SPEC TEXT");
  const cl = db
    .prepare(
      "SELECT content FROM run_artifacts WHERE run_id=1 AND kind='acceptance_checklist'",
    )
    .get();
  assert.deepEqual(JSON.parse(cl.content), ["does X", "does Y"]);
});

test("failed self-review throws gate error", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"spec":"s","plan":"p","acceptanceChecklist":[],"selfReviewPassed":false}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runSpecPlan({
      db, run, claude,
      issue: { number: 3, title: "T", body: "B" },
      cwd: "/wt", timeoutMs: 1000,
    }),
    /spec_plan: self-review did not pass/,
  );
});

test("timeout throws", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({ code: 1, timedOut: true, stdout: "", stderr: "" }),
  };
  await assert.rejects(
    runSpecPlan({
      db, run, claude,
      issue: { number: 3, title: "T", body: "B" },
      cwd: "/wt", timeoutMs: 1,
    }),
    /spec_plan: timed out/,
  );
});

test("prompt no longer mentions decomposition / sub-issues", async () => {
  const { buildSpecPlanPrompt } = await import("../src/stages/specPlan.js");
  const prompt = buildSpecPlanPrompt({ number: 1, title: "t", body: "b" });
  assert.ok(!/subIssues/i.test(prompt), "prompt must not mention subIssues");
  assert.ok(!/"size"/.test(prompt), "prompt must not declare a size field in RESULT schema");
  assert.ok(!/dependsOn/i.test(prompt), "prompt must not mention dependsOn");
});
