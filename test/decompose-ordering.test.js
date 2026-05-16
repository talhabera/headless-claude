// test/decompose-ordering.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { decompose } from "../src/decompose.js";

// Replicate the ctx(db) seed from test/decompose.test.js inline
function seedDb(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/x','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at) VALUES (1,2,'decomposing',1,'t','t')",
  ).run();
  return {
    project: db.prepare("SELECT * FROM projects WHERE id=1").get(),
    parentRun: db.prepare("SELECT * FROM runs WHERE id=1").get(),
  };
}

const subIssues = [
  { key: "api", title: "API", body: "", dependsOn: [] },
  { key: "ui", title: "UI", body: "", dependsOn: ["api"] },
];

async function runWithLog(db, project, parentRun) {
  const events = [];
  let n = 100;

  const gh = {
    createIssue: async (_repo, { title }) => {
      const number = ++n;
      events.push({ op: "create", title });
      return { number };
    },
    setLabel: async (_repo, number) => {
      const depsSnapshot = db
        .prepare(
          "SELECT issue_number,depends_on_issue_number FROM issue_deps WHERE project_id=?",
        )
        .all(project.id);
      events.push({ op: "label", number, depsSnapshot });
    },
    comment: async () => {
      events.push({ op: "comment" });
    },
  };

  await decompose({ db, gh, project, parentRun, subIssues });
  return events;
}

test("all creates happen before any label", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = seedDb(db);
  const events = await runWithLog(db, project, parentRun);

  const lastCreateIdx = events.reduce(
    (max, e, i) => (e.op === "create" ? i : max),
    -1,
  );
  const firstLabelIdx = events.findIndex((e) => e.op === "label");

  assert.ok(
    lastCreateIdx !== -1,
    "expected at least one create event",
  );
  assert.ok(
    firstLabelIdx !== -1,
    "expected at least one label event",
  );
  assert.ok(
    lastCreateIdx < firstLabelIdx,
    `last create (index ${lastCreateIdx}) must precede first label (index ${firstLabelIdx})`,
  );
});

test("deps exist before any sub-issue is labeled", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = seedDb(db);
  const events = await runWithLog(db, project, parentRun);

  const labelEvents = events.filter((e) => e.op === "label");
  assert.ok(labelEvents.length > 0, "expected label events");

  // The label event for the ui issue (number 102) must have the dep row present
  const uiLabelEvent = labelEvents.find((e) => e.number === 102);
  assert.ok(uiLabelEvent, "expected a label event for issue 102 (ui)");

  const hasDepRow = uiLabelEvent.depsSnapshot.some(
    (row) =>
      row.issue_number === 102 && row.depends_on_issue_number === 101,
  );
  assert.ok(
    hasDepRow,
    `label event for issue 102 must see dep row {issue_number:102, depends_on_issue_number:101}; got: ${JSON.stringify(uiLabelEvent.depsSnapshot)}`,
  );
});

test("rollup comment is last", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = seedDb(db);
  const events = await runWithLog(db, project, parentRun);

  assert.ok(events.length > 0, "expected events");
  const last = events[events.length - 1];
  assert.equal(
    last.op,
    "comment",
    `expected last event to be 'comment', got '${last.op}'`,
  );
});
