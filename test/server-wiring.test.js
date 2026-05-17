// test/server-wiring.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutonomous } from "../src/wire.js";

test("buildAutonomous returns wired components", () => {
  const a = buildAutonomous({ env: { DB_PATH: ":memory:" } });
  assert.ok(a.db);
  assert.ok(a.poller);
  assert.ok(a.scheduler);
  assert.ok(a.prSweep);
  assert.ok(a.prReview, "prReview not wired");
  assert.equal(typeof a.prReview.tick, "function");
  assert.equal(typeof a.mount, "function");
});
