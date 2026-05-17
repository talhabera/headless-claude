// test/workspace-difffingerprint.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../src/workspace.js";

function fakeMutex() {
  return { runExclusive: (_k, fn) => fn() };
}

test("diffFingerprint returns the patch-id hash for base...HEAD", async () => {
  const seen = [];
  const git = (cwd, args, opts) => {
    seen.push(args.join(" "));
    if (args[0] === "diff") return { code: 0, stdout: "DIFFTEXT", stderr: "" };
    if (args[0] === "patch-id") {
      assert.equal(opts && opts.input, "DIFFTEXT");
      return { code: 0, stdout: "abc123 0000000\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const ws = createWorkspace({ git, mutex: fakeMutex(), worktreesDir: "/tmp" });
  const fp = await ws.diffFingerprint({ base_branch: "main" }, "/wt");
  assert.equal(fp, "abc123");
  assert.ok(seen.some((s) => s.startsWith("diff origin/main...HEAD")));
  assert.ok(seen.some((s) => s.startsWith("patch-id --stable")));
});

test("diffFingerprint returns empty-string sentinel when diff is empty", async () => {
  const git = (cwd, args) =>
    args[0] === "diff"
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: "\n", stderr: "" };
  const ws = createWorkspace({ git, mutex: fakeMutex(), worktreesDir: "/tmp" });
  const fp = await ws.diffFingerprint({ base_branch: "main" }, "/wt");
  assert.equal(fp, "");
});
