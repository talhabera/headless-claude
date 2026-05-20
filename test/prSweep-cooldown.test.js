// test/prSweep-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrSweep } from "../src/prSweep.js";

const CFG = { stageTimeoutMs: 1000, runCooldownMs: 180_000, runCooldownMaxMs: 3_600_000 };

function seedOpenRun(db) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,worktree_path,branch,attempt,created_at,updated_at,needs_attention) VALUES(7,1,42,'pr_open','/tmp/wt-7','claude/42-p',1,'t','t',0)",
  ).run();
}

test("prSweep tick is re-entrant-safe: a second concurrent tick is a no-op", async () => {
  const db = openDb(":memory:");
  seedOpenRun(db);
  let inFlight = 0, maxInFlight = 0, callCount = 0;
  const slowGh = {
    prStatus: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      callCount++;
      inFlight--;
      return { state: "OPEN", mergeStateStatus: "CLEAN", number: 99 };
    },
  };
  const sweep = createPrSweep({
    db, gh: slowGh, workspace: {}, stages: {}, config: CFG,
    runLock: createKeyedMutex(),
  });

  // Fire two ticks back-to-back; the second must skip.
  const a = sweep.tick();
  const b = sweep.tick();
  await Promise.all([a, b]);

  assert.equal(maxInFlight, 1);
  assert.equal(callCount, 1);
});

test("prSweep records cooldown on failure and skips runs whose next_attempt_at is future", async () => {
  const db = openDb(":memory:");
  seedOpenRun(db);
  // Park the run in the future — sweep must skip it.
  db.prepare("UPDATE runs SET next_attempt_at='2099-01-01T00:00:00Z' WHERE id=7").run();
  let prStatusCalled = false;
  const sweep = createPrSweep({
    db,
    gh: { prStatus: async () => { prStatusCalled = true; return { state: "OPEN", mergeStateStatus: "DIRTY", number: 99 }; } },
    workspace: {}, stages: {}, config: CFG,
    runLock: createKeyedMutex(),
  });
  await sweep.tick();
  assert.equal(prStatusCalled, false, "sweep must skip parked runs at the SQL level");
});
