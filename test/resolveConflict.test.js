// test/resolveConflict.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runResolveConflict } from "../src/stages/resolveConflict.js";

test("returns resolved=true when claude reports success", async () => {
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"resolved":true,"summary":"merged both sides"}
RESULT>>>`,
    }),
  };
  const r = await runResolveConflict({
    claude, cwd: "/wt", files: ["a.js"], timeoutMs: 100,
  });
  assert.equal(r.resolved, true);
});

test("throws when claude cannot resolve", async () => {
  const claude = {
    run: async () => ({
      code: 0, timedOut: false, stderr: "",
      stdout: `<<<RESULT
{"resolved":false,"summary":"semantic conflict"}
RESULT>>>`,
    }),
  };
  await assert.rejects(
    runResolveConflict({ claude, cwd: "/wt", files: ["a.js"], timeoutMs: 100 }),
    /rebase-resolve: semantic conflict/,
  );
});

test("timeout throws", async () => {
  const claude = { run: async () => ({ code: 1, timedOut: true, stdout: "", stderr: "" }) };
  await assert.rejects(
    runResolveConflict({ claude, cwd: "/wt", files: [], timeoutMs: 1 }),
    /rebase-resolve: timed out/,
  );
});
