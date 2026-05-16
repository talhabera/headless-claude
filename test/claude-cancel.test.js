// test/claude-cancel.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

test("pre-aborted signal resolves cancelled without spawning", async () => {
  const controller = new AbortController();
  controller.abort(); // already aborted before calling run

  const claude = createClaude({
    bin: process.execPath,
    baseArgs: ["-e", "process.stdout.write('should-not-run'); process.exit(0)"],
  });

  const r = await claude.run({
    cwd: process.cwd(),
    prompt: "x",
    timeoutMs: 5000,
    signal: controller.signal,
  });

  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("abort mid-run kills child and resolves cancelled", async () => {
  const controller = new AbortController();

  const claude = createClaude({
    bin: process.execPath,
    baseArgs: ["-e", "setTimeout(()=>{}, 10000)"],
  });

  // abort after 150ms
  const abortTimer = setTimeout(() => controller.abort(), 150);

  const start = Date.now();
  const r = await claude.run({
    cwd: process.cwd(),
    prompt: "x",
    timeoutMs: 9000,
    signal: controller.signal,
  });
  const elapsed = Date.now() - start;

  clearTimeout(abortTimer);

  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  // resolved fast: did not wait for the 9000ms timeout
  assert.ok(elapsed < 1500, `expected fast resolve, got ${elapsed}ms`);
});
