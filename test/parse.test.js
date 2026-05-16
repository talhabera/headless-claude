// test/parse.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResultBlock } from "../src/stages/parse.js";

test("extracts JSON between markers", () => {
  const out = `chatter\n<<<RESULT\n{"size":"small","ok":true}\nRESULT>>>\nmore`;
  assert.deepEqual(parseResultBlock(out), { size: "small", ok: true });
});

test("throws when block missing", () => {
  assert.throws(() => parseResultBlock("no block here"), /no RESULT block/);
});

test("throws on invalid json", () => {
  assert.throws(
    () => parseResultBlock("<<<RESULT\n{bad}\nRESULT>>>"),
    /invalid RESULT json/,
  );
});
