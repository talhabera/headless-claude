// test/gh.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGh } from "../src/adapters/gh.js";

function fakeRunner(script) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const key = args.join(" ");
    for (const [match, out] of script) {
      if (key.includes(match)) return { code: 0, stdout: out, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

test("listLabeledIssues parses gh json", async () => {
  const runner = fakeRunner([
    [
      "issue list",
      JSON.stringify([
        { number: 4, title: "A", body: "do A", state: "OPEN" },
      ]),
    ],
  ]);
  const gh = createGh({ runner });
  const issues = await gh.listLabeledIssues("o/r", "claude-dev");
  assert.equal(issues[0].number, 4);
  assert.match(runner.calls[0].join(" "), /issue list.*--label claude-dev/);
});

test("swapLabel removes then adds", async () => {
  const runner = fakeRunner([]);
  const gh = createGh({ runner });
  await gh.swapLabel("o/r", 4, "claude-dev", "in-progress");
  const joined = runner.calls.map((c) => c.join(" "));
  assert.ok(joined.some((c) => /--remove-label claude-dev/.test(c)));
  assert.ok(joined.some((c) => /--add-label in-progress/.test(c)));
});

test("createPR returns url from stdout", async () => {
  const runner = fakeRunner([["pr create", "https://github.com/o/r/pull/9\n"]]);
  const gh = createGh({ runner });
  const pr = await gh.createPR("o/r", {
    head: "claude/4-r",
    base: "main",
    title: "t",
    body: "b",
  });
  assert.equal(pr.url, "https://github.com/o/r/pull/9");
});
