// test/scenario-restart-persists.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { recordFailure } from "../src/runCooldown.js";

test("S5: cooldown columns persist across a DB reopen (service restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-s5-"));
  const dbPath = join(dir, "auto.db");
  try {
    let db = openDb(dbPath);
    db.prepare(
      "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
    ).run();
    db.prepare(
      "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(7,1,42,'pr_open',1,'t','t')",
    ).run();
    const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
    const now = 1_700_000_000_000;
    recordFailure(db, 7, cfg, now);
    recordFailure(db, 7, cfg, now);
    recordFailure(db, 7, cfg, now);
    const before = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
    db.close();

    db = openDb(dbPath);
    const after = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
    assert.deepEqual(after, before);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
