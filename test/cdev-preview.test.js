// test/cdev-preview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("cdev --help lists --preview-branch and --preview-url flags", () => {
  const r = spawnSync("bash", ["cdev", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--preview-branch/);
  assert.match(r.stdout, /--preview-url/);
});
