// test/pr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { buildPrBody, runPr } from "../src/stages/pr.js";

test("buildPrBody renders checklist + closes", () => {
  const body = buildPrBody({
    issueNumber: 8,
    specExcerpt: "Build X",
    checklist: ["does A", "does B"],
  });
  assert.match(body, /Closes #8/);
  assert.match(body, /- \[x\] does A/);
  assert.match(body, /- \[x\] does B/);
});

test("runPr creates PR via gh and stores url", async () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','l','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,attempt,created_at,updated_at) VALUES (1,8,'reviewing','claude/8-o-r',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO run_artifacts (run_id,kind,content) VALUES (1,'spec','Build X'),(1,'acceptance_checklist','[\"does A\"]')",
  ).run();
  const run = db.prepare("SELECT * FROM runs WHERE id=1").get();
  const project = db.prepare("SELECT * FROM projects WHERE id=1").get();
  const gh = {
    createPR: async (repo, opts) => {
      assert.equal(opts.base, "main");
      assert.equal(opts.head, "claude/8-o-r");
      assert.match(opts.body, /Closes #8/);
      return { url: "https://github.com/o/r/pull/12" };
    },
  };
  const r = await runPr({ db, run, project, gh, issue: { title: "T" } });
  assert.equal(r.prUrl, "https://github.com/o/r/pull/12");
  const stored = db.prepare("SELECT pr_url FROM runs WHERE id=1").get();
  assert.equal(stored.pr_url, "https://github.com/o/r/pull/12");
});
