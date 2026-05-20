// test/claude-semaphore.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

test("semaphore caps simultaneous spawns at maxConcurrent", async () => {
  let inside = 0;
  let maxInside = 0;
  const fakeSpawn = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
    return { code: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false };
  };

  const claude = createClaude({
    bin: "fake",
    maxConcurrent: 2,
    minSpawnIntervalMs: 0,
    _spawn: fakeSpawn,
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      claude.run({ cwd: "/tmp", prompt: "x", timeoutMs: 60_000 }),
    ),
  );

  assert.equal(results.length, 10);
  assert.equal(maxInside, 2, `expected ≤2 concurrent, saw ${maxInside}`);
  assert.ok(results.every((r) => r.code === 0));
});
