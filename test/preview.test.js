// test/preview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeToPreview, pollUrl } from "../src/preview.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * scriptedGit returns a fake `git` runner that records all calls and returns
 * scripted responses keyed by substring match (same pattern as workspace.test.js).
 * Entries are tried in order; first match wins.
 * Unmatched calls default to {code:0, stdout:'', stderr:''}.
 */
function scriptedGit(map) {
  const calls = [];
  const git = (_cwd, args) => {
    const key = args.join(" ");
    calls.push(key);
    for (const [m, res] of map) if (key.includes(m)) return res;
    return { code: 0, stdout: "", stderr: "" };
  };
  git.calls = calls;
  return git;
}

const project = {
  local_path: "/clones/o-r",
  base_branch: "main",
  preview_branch: "preprod",
  preview_url: "https://preprod.example.com",
};
const runBranch = "claude/7-o-r";

// ---------------------------------------------------------------------------
// mergeToPreview tests
// ---------------------------------------------------------------------------

test("mergeToPreview happy: all git calls code 0 → ok:true with previewBranch", async () => {
  const git = scriptedGit([]); // all default to code 0
  const result = await mergeToPreview({ git, project, runBranch });

  assert.deepEqual(result, { ok: true, previewBranch: "preprod" });

  // Verify the three required git calls were made
  assert.ok(
    git.calls.some((c) => c.includes("fetch origin --prune")),
    "should call fetch origin --prune"
  );
  assert.ok(
    git.calls.some((c) => c.includes(`push origin ${runBranch}:${runBranch}`)),
    "should push run branch to origin"
  );
  assert.ok(
    git.calls.some((c) => c.includes(`push origin ${runBranch}:preprod`)),
    "should push run branch onto preview branch"
  );
});

test("mergeToPreview fetch fails → {ok:false, step:'fetch'} without preview push", async () => {
  const git = scriptedGit([
    ["fetch origin --prune", { code: 1, stdout: "", stderr: "fetch failed" }],
  ]);
  const result = await mergeToPreview({ git, project, runBranch });

  assert.equal(result.ok, false);
  assert.equal(result.step, "fetch");
  assert.equal(result.reason, "fetch failed");

  // Must NOT have attempted the preview push
  assert.ok(
    !git.calls.some((c) => c.includes(`push origin ${runBranch}:preprod`)),
    "should not attempt preview push after fetch failure"
  );
});

test("mergeToPreview non-fast-forward on preview push → {ok:false, step:'update-preview'}", async () => {
  const nffStderr = "! [rejected] preprod (non-fast-forward)";
  const git = scriptedGit([
    [
      `push origin ${runBranch}:preprod`,
      { code: 1, stdout: "", stderr: nffStderr },
    ],
  ]);
  const result = await mergeToPreview({ git, project, runBranch });

  assert.equal(result.ok, false);
  assert.equal(result.step, "update-preview");
  assert.ok(
    result.reason.includes(nffStderr),
    `reason should include stderr, got: ${result.reason}`
  );
});

// ---------------------------------------------------------------------------
// pollUrl tests
// ---------------------------------------------------------------------------

test("pollUrl resolves ok when fetch returns 200 on 2nd attempt (1st returns 503)", async () => {
  let callCount = 0;
  const fetchImpl = async (_url) => {
    callCount++;
    if (callCount === 1) return { status: 503 };
    return { status: 200 };
  };

  const result = await pollUrl("https://example.com", {
    timeoutMs: 2000,
    pollMs: 10,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.ok(result.elapsedMs >= 0, "elapsedMs should be >= 0");
  assert.equal(callCount, 2, "should have polled exactly twice");
});

test("pollUrl times out when always 503 → {ok:false} with reason mentioning timeout; resolves (not rejects)", async () => {
  const fetchImpl = async (_url) => ({ status: 503 });

  const result = await pollUrl("https://example.com", {
    timeoutMs: 60,
    pollMs: 20,
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(
    typeof result.reason === "string" && result.reason.includes("60"),
    `reason should mention 60ms timeout, got: ${result.reason}`
  );
});

test("pollUrl tolerates a thrown fetch error then succeeds → {ok:true}", async () => {
  let callCount = 0;
  const fetchImpl = async (_url) => {
    callCount++;
    if (callCount === 1) throw new Error("ECONNREFUSED");
    return { status: 200 };
  };

  const result = await pollUrl("https://example.com", {
    timeoutMs: 2000,
    pollMs: 10,
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(callCount, 2, "should have polled twice: error then success");
});
