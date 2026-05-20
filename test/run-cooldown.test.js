// test/run-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { recordSuccess, recordFailure } from "../src/runCooldown.js";

function seedRun(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,attempt,created_at,updated_at) VALUES(7,1,42,'pr_open',1,'t','t')",
  ).run();
}

test("recordSuccess clears failures and parks for runCooldownMs", () => {
  const db = openDb(":memory:");
  seedRun(db);
  const now = 1_700_000_000_000;
  recordSuccess(db, 7, { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 }, now);
  const r = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
  assert.equal(r.consecutive_failures, 0);
  assert.equal(new Date(r.next_attempt_at).getTime(), now + 180_000);
});

test("recordFailure escalates linearly and caps at runCooldownMaxMs", () => {
  const db = openDb(":memory:");
  seedRun(db);
  const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
  const now = 1_700_000_000_000;
  const deltas = [];
  for (let n = 1; n <= 25; n++) {
    recordFailure(db, 7, cfg, now);
    const r = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
    deltas.push({ n, failures: r.consecutive_failures, delta: new Date(r.next_attempt_at).getTime() - now });
  }
  assert.equal(deltas[0].failures, 1);
  assert.equal(deltas[0].delta, 360_000);   // 180 * (1+1)
  assert.equal(deltas[1].delta, 540_000);   // 180 * (1+2)
  assert.equal(deltas[2].delta, 720_000);   // 180 * (1+3)
  assert.equal(deltas[18].delta, 3_600_000); // 180 * 20 — exactly cap
  assert.equal(deltas[19].delta, 3_600_000); // capped
  assert.equal(deltas[24].delta, 3_600_000); // still capped
  assert.equal(deltas[24].failures, 25);
});

test("recordSuccess after failures resets the counter", () => {
  const db = openDb(":memory:");
  seedRun(db);
  const cfg = { runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };
  const now = 1_700_000_000_000;
  recordFailure(db, 7, cfg, now);
  recordFailure(db, 7, cfg, now);
  recordSuccess(db, 7, cfg, now);
  const r = db.prepare("SELECT next_attempt_at, consecutive_failures FROM runs WHERE id=7").get();
  assert.equal(r.consecutive_failures, 0);
  assert.equal(new Date(r.next_attempt_at).getTime(), now + 180_000);
});
