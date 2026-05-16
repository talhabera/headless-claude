// test/poller.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createPoller } from "../src/poller.js";

function project(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','claude-dev','main','t')",
  ).run();
  return db.prepare("SELECT * FROM projects WHERE id=1").get();
}

test("new labeled issue → queued run + label swapped", async () => {
  const db = openDb(":memory:");
  project(db);
  let swapped = null;
  const gh = {
    listLabeledIssues: async () => [{ number: 5, title: "A", body: "" }],
    swapLabel: async (_r, n, from, to) => (swapped = [n, from, to]),
    issue: async () => ({ state: "OPEN" }),
  };
  const poller = createPoller({ db, gh });
  await poller.tick();
  const run = db.prepare("SELECT * FROM runs WHERE issue_number=5").get();
  assert.equal(run.state, "queued");
  assert.deepEqual(swapped, [5, "claude-dev", "in-progress"]);
});

test("issue with unmet deps → blocked", async () => {
  const db = openDb(":memory:");
  project(db);
  db.prepare(
    "INSERT INTO issue_deps (project_id,issue_number,depends_on_issue_number) VALUES (1,9,8)",
  ).run();
  const gh = {
    listLabeledIssues: async () => [{ number: 9, title: "B", body: "" }],
    swapLabel: async () => {},
    issue: async (_r, n) => ({ state: n === 8 ? "OPEN" : "OPEN" }),
  };
  const poller = createPoller({ db, gh });
  await poller.tick();
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=9").get().state,
    "blocked",
  );
});

test("blocker closed → dependent blocked→queued", async () => {
  const db = openDb(":memory:");
  project(db);
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,9,'blocked',1,'t','t')",
  ).run();
  db.prepare(
    "INSERT INTO issue_deps (project_id,issue_number,depends_on_issue_number) VALUES (1,9,8)",
  ).run();
  const gh = {
    listLabeledIssues: async () => [],
    swapLabel: async () => {},
    issue: async (_r, n) => ({ state: n === 8 ? "CLOSED" : "OPEN", closed: n === 8 }),
  };
  const poller = createPoller({ db, gh });
  await poller.tick();
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=9").get().state,
    "queued",
  );
});

test("pr_open run whose issue closed → merged", async () => {
  const db = openDb(":memory:");
  project(db);
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,worktree_path,attempt,created_at,updated_at) VALUES (1,4,'pr_open','claude/4-o-r','/wt/4',1,'t','t')",
  ).run();
  const gh = {
    listLabeledIssues: async () => [],
    swapLabel: async () => {},
    issue: async () => ({ state: "CLOSED", closed: true }),
  };
  const removed = [];
  const workspace = {
    removeWorktree: async (_p, path, opts) => removed.push([path, opts]),
  };
  const poller = createPoller({ db, gh, workspace });
  await poller.tick();
  assert.equal(
    db.prepare("SELECT state FROM runs WHERE issue_number=4").get().state,
    "merged",
  );
  assert.equal(removed.length, 1);
  assert.equal(removed[0][0], "/wt/4");
  assert.deepEqual(removed[0][1], {
    deleteBranch: true,
    branch: "claude/4-o-r",
  });
});
