// test/claude.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaude } from "../src/adapters/claude.js";

test("run returns stdout and exit code", async () => {
  const claude = createClaude({
    bin: process.execPath,
    baseArgs: ["-e", "process.stdout.write('hello'); process.exit(0)"],
  });
  const r = await claude.run({ cwd: process.cwd(), prompt: "x", timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello/);
  assert.equal(r.timedOut, false);
});

test("timeout is reported", async () => {
  const claude = createClaude({
    bin: process.execPath,
    baseArgs: ["-e", "setTimeout(()=>{}, 10000)"],
  });
  const r = await claude.run({ cwd: process.cwd(), prompt: "x", timeoutMs: 200 });
  assert.equal(r.timedOut, true);
});
