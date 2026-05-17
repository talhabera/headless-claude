// test/stages-prReview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { runPrReview, buildPrReviewPrompt } from "../src/stages/prReview.js";

function seedRun(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,worktree_path,created_at,updated_at) VALUES (1,8,'pr_open','b','/wt','t','t')",
  ).run();
  return db.prepare("SELECT * FROM runs WHERE id=1").get();
}

test("buildPrReviewPrompt mentions code-review rigor and base diff", () => {
  const p = buildPrReviewPrompt("main");
  assert.match(p, /code-review/i);
  assert.match(p, /main\.\.\.HEAD|main\.\.HEAD/);
  assert.match(p, /DO NOT run `gh`/);
  assert.match(p, /<<<RESULT/);
});

test("runPrReview returns approve verdict and stores artifact", async () => {
  const db = openDb(":memory:");
  const run = seedRun(db);
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"verdict":"approve","findings":[],"notes":"ok"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const res = await runPrReview({
    db, run, claude, cwd: "/wt", base: "main", timeoutMs: 10,
  });
  assert.equal(res.verdict, "approve");
  const art = db
    .prepare("SELECT content FROM run_artifacts WHERE run_id=1 AND kind='pr_review_verdict'")
    .get();
  assert.ok(art && JSON.parse(art.content).verdict === "approve");
});

test("runPrReview normalizes any non-approve to changes-requested", async () => {
  const db = openDb(":memory:");
  const run = seedRun(db);
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"verdict":"changes-requested","findings":["hardcoded string"],"notes":"fix i18n"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const res = await runPrReview({ db, run, claude, cwd: "/wt", base: "main", timeoutMs: 10 });
  assert.equal(res.verdict, "changes-requested");
  assert.deepEqual(res.findings, ["hardcoded string"]);
});

test("runPrReview throws on claude non-zero exit", async () => {
  const db = openDb(":memory:");
  const run = seedRun(db);
  const claude = { run: async () => ({ code: 2, stdout: "", stderr: "bad" }) };
  await assert.rejects(
    () => runPrReview({ db, run, claude, cwd: "/wt", base: "main", timeoutMs: 10 }),
    /pr-review: claude exited 2/,
  );
});
