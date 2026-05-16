// test/mutex.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../src/mutex.js";

test("same key serializes; different keys run concurrently", async () => {
  const m = createKeyedMutex();
  const order = [];
  const slow = (tag, ms) =>
    m.runExclusive("A", async () => {
      order.push(`${tag}-start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-end`);
    });
  const p1 = slow("x", 30);
  const p2 = slow("y", 1);
  let bRan = false;
  const p3 = m.runExclusive("B", async () => {
    bRan = true;
  });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ["x-start", "x-end", "y-start", "y-end"]);
  assert.equal(bRan, true);
});

test("rejection releases the lock", async () => {
  const m = createKeyedMutex();
  await assert.rejects(
    m.runExclusive("K", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const v = await m.runExclusive("K", async () => 42);
  assert.equal(v, 42);
});
