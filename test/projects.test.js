// test/projects.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createProjects } from "../src/projects.js";

function fakeGit(record) {
  return (cwd, args) => {
    record.push([cwd, ...args]);
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("register clones once and persists row", async () => {
  const db = openDb(":memory:");
  const calls = [];
  const projects = createProjects({
    db,
    git: fakeGit(calls),
    projectsDir: "/tmp/projects",
  });
  const p = await projects.register({
    repo: "octo/widget",
    watchLabel: "claude-dev",
    baseBranch: "next",
  });
  assert.equal(p.slug, "octo-widget");
  assert.equal(p.local_path, "/tmp/projects/octo-widget");
  assert.match(calls[0].join(" "), /clone .*octo\/widget .*octo-widget/);
  const row = db.prepare("SELECT * FROM projects WHERE slug='octo-widget'").get();
  assert.equal(row.base_branch, "next");
});

test("re-register same repo is rejected", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({
    db,
    git: fakeGit([]),
    projectsDir: "/tmp/projects",
  });
  await projects.register({ repo: "o/r", watchLabel: "l", baseBranch: "main" });
  await assert.rejects(
    projects.register({ repo: "o/r", watchLabel: "l", baseBranch: "main" }),
    /already registered/,
  );
});

test("list and remove", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({ db, git: fakeGit([]), projectsDir: "/tmp/p" });
  await projects.register({ repo: "o/a", watchLabel: "l", baseBranch: "main" });
  assert.equal(projects.list().length, 1);
  projects.remove("o-a");
  assert.equal(projects.list().length, 0);
});

test("remove cleans up child rows and clone dir", async () => {
  const db = openDb(":memory:");
  // Use a real temp dir so rmSync can remove the cloned subdir
  const projectsDir = mkdtempSync(join(tmpdir(), "hc-projects-test-"));
  const calls = [];
  // Override fakeGit to also actually create the clone dir on disk
  const git = (cwd, args) => {
    calls.push([cwd, ...args]);
    // args = ["clone", url, slug] — create the slug dir to simulate a real clone
    const slug = args[2];
    mkdirSync(join(cwd, slug), { recursive: true });
    return { code: 0, stdout: "", stderr: "" };
  };
  const projects = createProjects({ db, git, projectsDir });

  // Register a project
  const p = await projects.register({ repo: "acme/app", watchLabel: "dev", baseBranch: "main" });
  const projectId = p.id;
  const cloneDir = p.local_path;

  // Assert clone dir exists before removal
  assert.ok(existsSync(cloneDir), "clone dir should exist before remove");

  // Insert a run for this project
  db.prepare(
    `INSERT INTO runs (project_id, issue_number, state, created_at, updated_at)
     VALUES (?, 1, 'open', '2024-01-01', '2024-01-01')`
  ).run(projectId);
  const run = db.prepare("SELECT id FROM runs WHERE project_id=?").get(projectId);
  const runId = run.id;

  // Insert child rows
  db.prepare("INSERT INTO run_logs (run_id, stage, level, message, ts) VALUES (?,?,?,?,?)").run(
    runId, "plan", "info", "hello", "2024-01-01"
  );
  db.prepare("INSERT INTO run_artifacts (run_id, kind, content) VALUES (?,?,?)").run(
    runId, "diff", "some diff"
  );
  db.prepare(
    "INSERT INTO issue_deps (project_id, issue_number, depends_on_issue_number) VALUES (?,?,?)"
  ).run(projectId, 1, 2);

  // Act
  projects.remove("acme-app");

  // Assert project row gone
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id=?").get(projectId).c,
    0,
    "project row should be deleted"
  );

  // Assert child rows gone
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM runs WHERE project_id=?").get(projectId).c,
    0,
    "runs should be deleted"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM run_logs WHERE run_id=?").get(runId).c,
    0,
    "run_logs should be deleted"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM run_artifacts WHERE run_id=?").get(runId).c,
    0,
    "run_artifacts should be deleted"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM issue_deps WHERE project_id=?").get(projectId).c,
    0,
    "issue_deps should be deleted"
  );

  // Assert clone dir gone
  assert.ok(!existsSync(cloneDir), "clone dir should be removed");
});

test("remove is idempotent when project does not exist", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({ db, git: fakeGit([]), projectsDir: "/tmp/p" });
  // Should not throw when slug doesn't exist
  assert.doesNotThrow(() => projects.remove("nonexistent-slug"));
});
