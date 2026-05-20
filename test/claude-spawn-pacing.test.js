// test/claude-spawn-pacing.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

function fakeClock(initialMs) {
  let t = initialMs;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

test("global pacing spaces consecutive spawns by minSpawnIntervalMs", async () => {
  const clock = fakeClock(0);
  const spawnTimes = [];
  const fakeSpawn = async () => {
    spawnTimes.push(clock.now());
    return { code: 0, stdout: "", stderr: "", timedOut: false, cancelled: false };
  };
  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 5,            // larger than call count — pacing is the only constraint
    minSpawnIntervalMs: 180_000,
    now: clock.now,
    sleep: clock.sleep,
    _spawn: fakeSpawn,
  });

  await claude.run({ cwd: "/tmp", prompt: "1", timeoutMs: 60_000 });
  await claude.run({ cwd: "/tmp", prompt: "2", timeoutMs: 60_000 });
  await claude.run({ cwd: "/tmp", prompt: "3", timeoutMs: 60_000 });

  assert.equal(spawnTimes[0], 0);
  assert.equal(spawnTimes[1], 180_000);
  assert.equal(spawnTimes[2], 360_000);
});

test("pacing applies even when prior spawn was fast/failing", async () => {
  const clock = fakeClock(0);
  const spawnTimes = [];
  const fakeSpawn = async () => {
    spawnTimes.push(clock.now());
    return { code: 1, stdout: "", stderr: "limit", timedOut: false, cancelled: false };
  };
  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 5,
    minSpawnIntervalMs: 180_000,
    now: clock.now,
    sleep: clock.sleep,
    _spawn: fakeSpawn,
  });

  await claude.run({ cwd: "/tmp", prompt: "1", timeoutMs: 60_000 });
  await claude.run({ cwd: "/tmp", prompt: "2", timeoutMs: 60_000 });

  assert.equal(spawnTimes[1] - spawnTimes[0], 180_000);
});
