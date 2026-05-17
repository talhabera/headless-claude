// test/config-pr-review.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("pr-review config defaults", () => {
  const c = loadConfig({});
  assert.equal(c.prReviewMs, 120000);
  assert.equal(c.prReviewMaxIterations, 4);
  assert.equal(c.botLogin, "");
});

test("pr-review config env overrides", () => {
  const c = loadConfig({
    PR_REVIEW_MS: "5000",
    PR_REVIEW_MAX_ITERATIONS: "2",
    PR_BOT_LOGIN: "my-bot",
  });
  assert.equal(c.prReviewMs, 5000);
  assert.equal(c.prReviewMaxIterations, 2);
  assert.equal(c.botLogin, "my-bot");
});
