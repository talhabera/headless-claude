// test/db-cooldown-columns.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

const NEW_COLS = ["next_attempt_at", "consecutive_failures"];

test("fresh :memory: db has cooldown columns on runs", () => {
  const db = openDb(":memory:");
  const cols = db.prepare("PRAGMA table_info(runs)").all().map((r) => r.name);
  for (const c of NEW_COLS) assert.ok(cols.includes(c), `missing ${c}`);
});

test("openDb migrates a pre-existing runs table WITHOUT cooldown columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-cd-"));
  const dbPath = join(dir, "test.db");
  try {
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, project_id INTEGER, issue_number INTEGER,
        parent_run_id INTEGER, state TEXT, worktree_path TEXT, branch TEXT,
        pr_url TEXT, attempt INTEGER DEFAULT 1, fail_reason TEXT,
        last_synced_base_sha TEXT, needs_attention INTEGER DEFAULT 0,
        attention_reason TEXT, created_at TEXT, updated_at TEXT);
    `);
    old.prepare(
      "INSERT INTO runs (project_id,issue_number,state,created_at,updated_at) VALUES (1,1,'pr_open','t','t')",
    ).run();
    old.close();

    const db = openDb(dbPath);
    const cols = db.prepare("PRAGMA table_info(runs)").all().map((r) => r.name);
    for (const c of NEW_COLS) assert.ok(cols.includes(c), `missing ${c}`);
    const row = db.prepare("SELECT * FROM runs WHERE id=1").get();
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.next_attempt_at, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDb is idempotent — second open does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-cd2-"));
  const dbPath = join(dir, "test.db");
  try {
    openDb(dbPath).close();
    assert.doesNotThrow(() => openDb(dbPath).close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
