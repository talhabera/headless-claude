// test/wire-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAutonomous } from "../src/wire.js";

test("buildAutonomous wires runCooldown config + runLock without crashing", async () => {
  const root = mkdtempSync(join(tmpdir(), "hc-wire-"));
  try {
    const env = {
      HOME: root,
      AUTONOMOUS_DIR: join(root, "auto"),
      PROJECTS_DIR: join(root, "auto", "projects"),
      WORKTREES_DIR: join(root, "auto", "worktrees"),
      DB_PATH: join(root, "auto", "auto.db"),
    };
    // Pre-create dirs (openDb does not mkdir parents — see CLAUDE.md).
    mkdirSync(env.PROJECTS_DIR, { recursive: true });
    mkdirSync(env.WORKTREES_DIR, { recursive: true });

    const sys = buildAutonomous({ env });
    assert.equal(sys.config.runCooldownMs, 180_000);
    assert.equal(sys.config.runCooldownMaxMs, 3_600_000);
    assert.equal(sys.config.claudeMinSpawnIntervalMs, 180_000);
    assert.ok(sys.prSweep && typeof sys.prSweep.tick === "function");
    assert.ok(sys.prReview && typeof sys.prReview.tick === "function");
    assert.ok(sys.executor && typeof sys.executor.execute === "function");
    // Stricter check: tick() must not throw "Cannot read properties of undefined (reading 'runExclusive')"
    // — i.e. runLock must actually be passed through.
    await sys.prSweep.tick();
    await sys.prReview.tick();
    sys.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
