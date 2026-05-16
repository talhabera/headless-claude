// test/db-preview-columns.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

test("fresh :memory: db has preview_branch and preview_url columns", () => {
  const db = openDb(":memory:");
  const cols = db
    .prepare("PRAGMA table_info(projects)")
    .all()
    .map((r) => r.name);
  assert.ok(cols.includes("preview_branch"), "missing preview_branch");
  assert.ok(cols.includes("preview_url"), "missing preview_url");
});

test("openDb migrates pre-existing db WITHOUT the new columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-test-"));
  const dbPath = join(dir, "test.db");
  try {
    // Create a DB that looks like an old one — projects table WITHOUT the new columns
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, slug TEXT UNIQUE, repo TEXT, local_path TEXT,
        watch_label TEXT, base_branch TEXT, created_at TEXT);
    `);
    old.prepare(
      "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('p','o/p','/x','l','main','t')",
    ).run();
    old.close();

    // Now open via openDb — migration should add the columns
    const db = openDb(dbPath);
    const cols = db
      .prepare("PRAGMA table_info(projects)")
      .all()
      .map((r) => r.name);
    assert.ok(cols.includes("preview_branch"), "migration did not add preview_branch");
    assert.ok(cols.includes("preview_url"), "migration did not add preview_url");

    // Existing row should survive with NULL values for the new columns
    const row = db.prepare("SELECT * FROM projects WHERE slug='p'").get();
    assert.ok(row, "existing row missing after migration");
    assert.equal(row.preview_branch, null, "preview_branch should be NULL for old row");
    assert.equal(row.preview_url, null, "preview_url should be NULL for old row");
    db.close();

    // Second openDb call — ALTER guard must not throw
    assert.doesNotThrow(() => {
      const db2 = openDb(dbPath);
      db2.close();
    }, "second openDb call threw (ALTER guard failed)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh :memory: db round-trips preview_branch and preview_url", () => {
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,preview_branch,preview_url,created_at) VALUES ('p2','o/p2','/x2','l','main','feat/preview','https://preview.example.com','t')",
  ).run();
  const row = db.prepare("SELECT * FROM projects WHERE slug='p2'").get();
  assert.equal(row.preview_branch, "feat/preview");
  assert.equal(row.preview_url, "https://preview.example.com");
});
