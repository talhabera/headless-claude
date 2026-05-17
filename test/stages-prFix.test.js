// test/stages-prFix.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPrFix, buildPrFixPrompt } from "../src/stages/prFix.js";

test("buildPrFixPrompt embeds the change request and TDD/baseline + constraints", () => {
  const p = buildPrFixPrompt("Use Turkish chars: Yorumlarınız");
  assert.match(p, /Yorumlarınız/);
  assert.match(p, /TDD|test-driven/i);
  assert.match(p, /BASELINE PROTOCOL/);
  assert.match(p, /DO NOT run `gh`/);
  assert.match(p, /<<<RESULT/);
});

test("runPrFix returns ok when gate passes", async () => {
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"noNewFailures":true,"changeTestsPass":true,"summary":"fixed copy"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const r = await runPrFix({
    claude, cwd: "/wt", changeRequest: "fix it", timeoutMs: 10,
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /fixed copy/);
});

test("runPrFix returns ok:false with summary when gate not green", async () => {
  const claude = {
    run: async () => ({
      code: 0,
      stdout: '<<<RESULT\n{"noNewFailures":false,"changeTestsPass":true,"summary":"introduced lint error"}\nRESULT>>>',
      stderr: "",
    }),
  };
  const r = await runPrFix({ claude, cwd: "/wt", changeRequest: "x", timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /introduced lint error/);
});

test("runPrFix throws on claude non-zero exit", async () => {
  const claude = { run: async () => ({ code: 1, stdout: "", stderr: "nope" }) };
  await assert.rejects(
    () => runPrFix({ claude, cwd: "/wt", changeRequest: "x", timeoutMs: 10 }),
    /pr-fix: claude exited 1/,
  );
});
