// test/prReview-cooldown.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createPrReview } from "../src/prReview.js";

const CFG = {
  stageTimeoutMs: 1000,
  prReviewMaxIterations: 4,
  runCooldownMs: 180_000,
  runCooldownMaxMs: 3_600_000,
  botLogin: "bot",
};

function seedOpenRun(db, wtPath) {
  db.prepare(
    "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main','/tmp/p','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs(id,project_id,issue_number,state,worktree_path,branch,attempt,created_at,updated_at,needs_attention) VALUES(7,1,42,'pr_open',?,'claude/42-p',1,'t','t',0)",
  ).run(wtPath);
}

test("prReview tick is re-entrant: a second concurrent tick is a no-op", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hc-prr-"));
  try {
    const db = openDb(":memory:");
    seedOpenRun(db, tmp);
    let calls = 0;
    const gh = {
      prStatus: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { state: "OPEN", number: 99 }; },
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
    };
    const review = createPrReview({
      db, gh, workspace: { diffFingerprint: async () => "fp", pushBranch: async () => {} },
      stages: { runPrReview: async () => ({ verdict: "approve" }), runPrFix: async () => ({ ok: true, summary: "" }) },
      claude: {}, config: CFG, runLock: createKeyedMutex(),
    });
    const a = review.tick();
    const b = review.tick();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prReview records failure when a stage throws (claude exit 1 path)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hc-prr2-"));
  try {
    const db = openDb(":memory:");
    seedOpenRun(db, tmp);
    // Cold-start: no comments → first tick records baseline and skips. Set the watermark up-front.
    db.prepare("UPDATE runs SET pr_last_comment_at='2020-01-01T00:00:00Z' WHERE id=7").run();
    const gh = {
      prStatus: async () => ({ state: "OPEN", number: 99 }),
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
    };
    const review = createPrReview({
      db, gh,
      workspace: { diffFingerprint: async () => "fp", pushBranch: async () => {} },
      stages: {
        runPrReview: async () => { throw new Error("claude exited 1"); },
        runPrFix: async () => ({ ok: true, summary: "" }),
      },
      claude: {}, config: CFG, runLock: createKeyedMutex(),
    });
    await review.tick();
    const r = db.prepare("SELECT consecutive_failures, next_attempt_at FROM runs WHERE id=7").get();
    assert.equal(r.consecutive_failures, 1);
    assert.ok(r.next_attempt_at, "next_attempt_at should be set after a failure");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
