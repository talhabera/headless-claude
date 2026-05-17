// test/implement-baseline.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runImplement, buildImplementPrompt } from "../src/stages/implement.js";

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

// Case 1: noNewFailures:true, changeTestsPass:true (no allGreen field) → resolves
test("baseline gate passes when noNewFailures:true and changeTestsPass:true", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, cancelled: false, stderr: "",
      stdout: `<<<RESULT
{"noNewFailures":true,"changeTestsPass":true,"baseline":"2 pre-existing ESLint errors","summary":"added feature, no new failures"}
RESULT>>>`,
    }),
  };
  const r = await runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.allGreen, true);
  assert.ok(typeof r.summary === "string");
});

// Case 2: noNewFailures:false, changeTestsPass:true → rejects
test("baseline gate rejects when noNewFailures:false", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, cancelled: false, stderr: "",
      stdout: `<<<RESULT
{"noNewFailures":false,"changeTestsPass":true,"baseline":"clean","summary":"introduced 2 new lint errors"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 }),
    /implement: gate not green/,
  );
});

// Case 3: noNewFailures:true, changeTestsPass:false → rejects
test("baseline gate rejects when changeTestsPass:false", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, cancelled: false, stderr: "",
      stdout: `<<<RESULT
{"noNewFailures":true,"changeTestsPass":false,"baseline":"clean","summary":"own tests still failing"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 }),
    /implement: gate not green/,
  );
});

// Case 4: back-compat — legacy allGreen:true → resolves
test("back-compat: legacy allGreen:true still passes", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, cancelled: false, stderr: "",
      stdout: `<<<RESULT
{"allGreen":true,"summary":"x"}
RESULT>>>`,
    }),
  };
  const r = await runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 });
  assert.equal(r.allGreen, true);
});

// Case 5: back-compat — legacy allGreen:false (no noNewFailures) → rejects
test("back-compat: legacy allGreen:false (no noNewFailures) still rejects", async () => {
  const db = openDb(":memory:");
  const run = seed(db);
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, cancelled: false, stderr: "",
      stdout: `<<<RESULT
{"allGreen":false,"summary":"3 failing"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runImplement({ db, run, claude, cwd: "/wt", timeoutMs: 1000 }),
    /implement: gate not green/,
  );
});

// Case 6: prompt contains prohibition phrases AND baseline-protocol wording
test("buildImplementPrompt contains prohibition phrases and baseline-protocol wording", () => {
  const prompt = buildImplementPrompt("PLAN");
  // Existing prohibition phrases (must remain verbatim)
  assert.ok(prompt.includes("DO NOT run `gh`"), "must contain: DO NOT run `gh`");
  assert.ok(prompt.includes("git push"), "must contain: git push");
  assert.ok(prompt.includes("automated orchestrator"), "must contain: automated orchestrator");
  // New baseline-protocol wording
  assert.ok(
    prompt.toLowerCase().includes("baseline"),
    "must contain baseline wording",
  );
  assert.ok(
    prompt.toLowerCase().includes("no new") || prompt.toUpperCase().includes("NEW FAILURE"),
    "must contain 'no new' or 'NEW FAILURE' wording",
  );
  assert.ok(
    prompt.includes("noNewFailures"),
    "must contain noNewFailures key in RESULT block",
  );
});
