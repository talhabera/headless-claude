// test/server-wiring.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutonomous } from "../src/wire.js";

test("buildAutonomous returns wired components", () => {
  const a = buildAutonomous({ env: { DB_PATH: ":memory:" } });
  assert.ok(a.db);
  assert.ok(a.poller);
  assert.ok(a.scheduler);
  assert.equal(typeof a.mount, "function");
});

test("buildAutonomous no longer exports prSweep / prReview members", () => {
  const a = buildAutonomous({ env: { DB_PATH: ":memory:" } });
  assert.equal(a.prSweep, undefined, "prSweep must not be wired");
  assert.equal(a.prReview, undefined, "prReview must not be wired");
});

test("buildAutonomous config drops post-PR knobs", () => {
  const a = buildAutonomous({ env: { DB_PATH: ":memory:" } });
  assert.equal(a.config.prSyncMs, undefined, "prSyncMs must not be in config");
  assert.equal(a.config.prReviewMs, undefined, "prReviewMs must not be in config");
  assert.equal(a.config.prReviewMaxIterations, undefined, "prReviewMaxIterations must not be in config");
  assert.equal(a.config.botLogin, undefined, "botLogin must not be in config");
});
