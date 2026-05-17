// test/gh-pr.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGh } from "../src/adapters/gh.js";

test("prComments parses comments array", async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: JSON.stringify({
        comments: [
          { id: "C1", author: { login: "alice" }, body: "fix x", createdAt: "2026-05-17T10:00:00Z" },
        ],
      }),
      stderr: "",
    };
  };
  const gh = createGh({ runner });
  const out = await gh.prComments("o/r", "claude/8-o-r");
  assert.equal(out.length, 1);
  assert.equal(out[0].author.login, "alice");
  assert.deepEqual(calls[0].slice(0, 4), ["pr", "view", "claude/8-o-r", "-R"]);
  assert.ok(calls[0].includes("comments"));
});

test("prComments returns [] when no comments key", async () => {
  const gh = createGh({ runner: () => ({ code: 0, stdout: "{}", stderr: "" }) });
  assert.deepEqual(await gh.prComments("o/r", "b"), []);
});

test("prComment posts a body to the PR number", async () => {
  let seen;
  const gh = createGh({
    runner: (args) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await gh.prComment("o/r", 36, "hello");
  assert.deepEqual(seen, ["pr", "comment", "36", "-R", "o/r", "--body", "hello"]);
});

test("viewer returns the authenticated login trimmed", async () => {
  const gh = createGh({
    runner: (args) => {
      assert.deepEqual(args, ["api", "user", "-q", ".login"]);
      return { code: 0, stdout: "octo-bot\n", stderr: "" };
    },
  });
  assert.equal(await gh.viewer(), "octo-bot");
});

test("prComment surfaces gh failure", async () => {
  const gh = createGh({
    runner: () => ({ code: 1, stdout: "", stderr: "boom" }),
  });
  await assert.rejects(() => gh.prComment("o/r", 1, "x"), /pr comment failed: boom/);
});
