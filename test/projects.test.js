// test/projects.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
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
