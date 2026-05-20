// test/scenario-quota-exhausted.test.js
// Regression for 2026-05-20: three pr_open runs that are DIRTY against main,
// claude always exits 1 (quota exhausted). Under the OLD behavior the
// prSweep + prReview intervals produced 150+ spawns/hour. Under the NEW
// behavior the per-run cooldown + global pacing cap it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createClaude } from "../src/adapters/claude.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrSweep } from "../src/prSweep.js";
import { createPrReview } from "../src/prReview.js";

function fakeClock(initialMs) {
  let t = initialMs;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

test("S3: 3 pr_open runs + claude exit 1 + 1h of intervals → bounded spawn count", async () => {
  const clock = fakeClock(new Date("2026-05-20T20:32:00Z").getTime());
  const db = openDb(":memory:");
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  for (const id of [20, 27, 51]) {
    db.prepare(
      "INSERT INTO runs(id,project_id,issue_number,state,worktree_path,branch,attempt,created_at,updated_at,needs_attention) VALUES(?,1,?,'pr_open',?,?,1,'t','t',0)",
    ).run(id, id + 5, `/tmp/wt-${id}`, `claude/${id + 5}-p`);
  }

  let spawnCount = 0;
  const fakeSpawn = async () => {
    spawnCount++;
    return { code: 1, stdout: "", stderr: "limit", timedOut: false, cancelled: false };
  };
  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 2,
    minSpawnIntervalMs: 180_000,
    now: clock.now,
    sleep: clock.sleep,
    _spawn: fakeSpawn,
  });

  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY", number: 99 }),
    prComments: async () => [],
    viewer: async () => "bot",
    prComment: async () => {},
    comment: async () => {},
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: true, files: ["a"] }),
    abortRebase: async () => {},
    pushBranch: async () => {},
    diffFingerprint: async () => "fp",
  };
  const stages = {
    claude,
    runResolveConflict: async (o) => {
      const r = await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 });
      if (r.code !== 0) throw new Error("claude exited 1");
    },
    runPrReview: async (o) => {
      const r = await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 });
      if (r.code !== 0) throw new Error("claude exited 1");
      return { verdict: "approve" };
    },
    runPrFix: async () => ({ ok: true, summary: "" }),
  };
  const config = {
    stageTimeoutMs: 1000,
    prReviewMaxIterations: 4,
    runCooldownMs: 180_000,
    runCooldownMaxMs: 3_600_000,
    botLogin: "bot",
  };
  const runLock = createKeyedMutex();

  const prSweep = createPrSweep({ db, gh, workspace, stages, config, runLock, now: clock.now });
  const prReview = createPrReview({ db, gh, workspace, stages, claude, config, runLock, now: clock.now });

  // Simulate 1 hour with prSweep every 60s and prReview every 120s.
  const HOUR = 60 * 60 * 1000;
  for (let elapsed = 0; elapsed < HOUR; elapsed += 60_000) {
    await prSweep.tick();
    if (elapsed % 120_000 === 0) await prReview.tick();
    clock.advance(60_000);
  }

  // 1 hour of bursts at the OLD rate produced 150+ spawns. The new throttles cap it well below that.
  assert.ok(spawnCount <= 25, `expected ≤25 spawns/hour, got ${spawnCount}`);

  const rows = db.prepare("SELECT id, consecutive_failures FROM runs WHERE id IN (20,27,51)").all();
  for (const r of rows) {
    assert.ok(r.consecutive_failures >= 1, `run ${r.id} should have at least one recorded failure`);
  }
});
