// test/decompose.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { decompose } from "../src/decompose.js";

function ctx(db) {
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

test("creates sub-issues with watch label and records deps", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = ctx(db);
  const created = [];
  let n = 100;
  const gh = {
    createIssue: async (_r, { title }) => {
      created.push(title);
      return { number: ++n };
    },
    setLabel: async () => {},
    comment: async () => {},
  };
  await decompose({
    db, gh, project, parentRun,
    subIssues: [
      { key: "api", title: "API", body: "build api", dependsOn: [] },
      { key: "ui", title: "UI", body: "build ui", dependsOn: ["api"] },
    ],
  });
  assert.deepEqual(created, ["API", "UI"]);
  const dep = db
    .prepare("SELECT * FROM issue_deps WHERE project_id=1 AND issue_number=102")
    .get();
  assert.equal(dep.depends_on_issue_number, 101);
});

test("cyclic DAG rejected before any issue is created", async () => {
  const db = openDb(":memory:");
  const { project, parentRun } = ctx(db);
  let calls = 0;
  const gh = { createIssue: async () => (calls++, { number: 1 }), setLabel: async () => {} };
  await assert.rejects(
    decompose({
      db, gh, project, parentRun,
      subIssues: [
        { key: "a", title: "A", body: "", dependsOn: ["b"] },
        { key: "b", title: "B", body: "", dependsOn: ["a"] },
      ],
    }),
    /cyclic/,
  );
  assert.equal(calls, 0);
});
