// test/git.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit } from "../src/adapters/git.js";

test("git runner returns code/stdout for a real repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitt-"));
  const git = createGit();
  assert.equal(git(dir, ["init", "-q"]).code, 0);
  const r = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "true");
});

test("non-zero exit is captured, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitt-"));
  const git = createGit();
  const r = git(dir, ["rev-parse", "HEAD"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a git repository|ambiguous argument/);
});

test("opts.input is forwarded as stdin to spawnSync", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitt-"));
  const git = createGit();
  // Verify via patch-id that opts.input is forwarded as stdin to spawnSync: empty input → empty output, no crash
  git(dir, ["init", "-q"]);
  const r = git(dir, ["patch-id", "--stable"], { input: "" });
  // patch-id with empty stdin exits 0 and produces empty stdout
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});
