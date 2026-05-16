// test/cdev.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("cdev --help prints usage", () => {
  const r = spawnSync("bash", ["cdev", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cdev add/);
  assert.match(r.stdout, /cdev runs/);
});
