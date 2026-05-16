// test/dag.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasCycle } from "../src/dag.js";

test("acyclic returns false", () => {
  assert.equal(
    hasCycle([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["a", "b"] },
    ]),
    false,
  );
});

test("self-loop is a cycle", () => {
  assert.equal(hasCycle([{ key: "a", dependsOn: ["a"] }]), true);
});

test("two-node cycle detected", () => {
  assert.equal(
    hasCycle([
      { key: "a", dependsOn: ["b"] },
      { key: "b", dependsOn: ["a"] },
    ]),
    true,
  );
});
