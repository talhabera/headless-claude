// src/db.js
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE, repo TEXT, local_path TEXT,
  watch_label TEXT, base_branch TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, project_id INTEGER, issue_number INTEGER,
  parent_run_id INTEGER, state TEXT, worktree_path TEXT, branch TEXT,
  pr_url TEXT, attempt INTEGER DEFAULT 1, fail_reason TEXT,
  last_synced_base_sha TEXT, needs_attention INTEGER DEFAULT 0,
  attention_reason TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(project_id, issue_number, attempt));
CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY, run_id INTEGER, stage TEXT, level TEXT,
  message TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id INTEGER, kind TEXT, content TEXT,
  PRIMARY KEY (run_id, kind));
CREATE TABLE IF NOT EXISTS issue_deps (
  project_id INTEGER, issue_number INTEGER, depends_on_issue_number INTEGER,
  PRIMARY KEY (project_id, issue_number, depends_on_issue_number));
`;

export function openDb(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
