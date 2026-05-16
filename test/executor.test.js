// test/executor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createExecutor } from "../src/executor.js";

function base(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/clones/o-r','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,8,'queued',1,'t','t')",
  ).run();
  return {
    run: db.prepare("SELECT * FROM runs WHERE id=1").get(),
    project: db.prepare("SELECT * FROM projects WHERE id=1").get(),
  };
}

const ws = {
  prepareClone: async () => "sha0",
  addWorktree: async () => ({ path: "/wt/o-r-8-1", branch: "claude/8-o-r" }),
  removeWorktree: async () => {},
  rebaseOnBase: async () => ({ conflicted: false }),
};
const gh = {
  issue: async () => ({ number: 8, title: "T", body: "B", state: "OPEN" }),
  comment: async () => {},
  swapLabel: async () => {},
  setLabel: async () => {},
  createPR: async () => ({ url: "https://github.com/o/r/pull/1" }),
};

test("small issue: queued → pr_open", async () => {
  const db = openDb(":memory:");
  const { run, project } = base(db);
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => ({ verdict: "approve", notes: "", checklist: [] }),
    runPr: async ({ db, run }) => {
      db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run("u", run.id);
      return { prUrl: "u" };
    },
  };
  const ex = createExecutor({ db, gh, workspace: ws, stages, decompose: async () => {}, config: { stageTimeoutMs: 10 } });
  await ex.execute(run.id);
  assert.equal(db.prepare("SELECT state FROM runs WHERE id=1").get().state, "pr_open");
});

test("review changes-requested loops once then fails on 2nd", async () => {
  const db = openDb(":memory:");
  const { run } = base(db);
  let reviews = 0;
  const stages = {
    runSpecPlan: async () => ({ size: "small", subIssues: [] }),
    runImplement: async () => ({ allGreen: true }),
    runReview: async () => {
      reviews++;
      return { verdict: "changes-requested", notes: "no", checklist: [] };
    },
    runPr: async () => ({ prUrl: "u" }),
  };
  const ex = createExecutor({ db, gh, workspace: ws, stages, decompose: async () => {}, config: { stageTimeoutMs: 10 } });
  await ex.execute(run.id);
  assert.equal(reviews, 2);
  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /review/);
});

test("stage throw → failed + issue comment", async () => {
  const db = openDb(":memory:");
  const { run } = base(db);
  let commented = false;
  const gh2 = { ...gh, comment: async () => { commented = true; } };
  const stages = {
    runSpecPlan: async () => {
      throw new Error("spec_plan: timed out");
    },
  };
  const ex = createExecutor({ db, gh: gh2, workspace: ws, stages, decompose: async () => {}, config: { stageTimeoutMs: 10 } });
  await ex.execute(run.id);
  const r = db.prepare("SELECT state, fail_reason FROM runs WHERE id=1").get();
  assert.equal(r.state, "failed");
  assert.match(r.fail_reason, /spec_plan: timed out/);
  assert.equal(commented, true);
});
