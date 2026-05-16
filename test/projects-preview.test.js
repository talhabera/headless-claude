// test/projects-preview.test.js
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

test("register with previewBranch and previewUrl persists both columns", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({
    db,
    git: fakeGit([]),
    projectsDir: "/tmp/projects",
  });
  const p = await projects.register({
    repo: "o/r",
    watchLabel: "l",
    baseBranch: "main",
    previewBranch: "preprod",
    previewUrl: "https://preprod.example.com",
  });
  assert.equal(p.preview_branch, "preprod");
  assert.equal(p.preview_url, "https://preprod.example.com");
  assert.equal(p.base_branch, "main");
  // Verify DB row also has the values
  const row = db.prepare("SELECT * FROM projects WHERE slug='o-r'").get();
  assert.equal(row.preview_branch, "preprod");
  assert.equal(row.preview_url, "https://preprod.example.com");
});

test("register without preview fields defaults to null (back-compat)", async () => {
  const db = openDb(":memory:");
  const projects = createProjects({
    db,
    git: fakeGit([]),
    projectsDir: "/tmp/projects",
  });
  const p = await projects.register({
    repo: "o/r2",
    watchLabel: "l",
    baseBranch: "main",
  });
  assert.equal(p.preview_branch, null);
  assert.equal(p.preview_url, null);
  // Verify DB row too
  const row = db.prepare("SELECT * FROM projects WHERE slug='o-r2'").get();
  assert.equal(row.preview_branch, null);
  assert.equal(row.preview_url, null);
});
