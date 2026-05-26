// test/scenario-burst-labeling.test.js
// Operator labels 5 issues simultaneously. The semaphore in createClaude must
// cap concurrent spawns at maxConcurrent=2 even though the executor wants
// to run them in parallel up to scheduler's maxConcurrentRuns=2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { createClaude } from "../src/adapters/claude.js";
import { createKeyedMutex } from "../src/mutex.js";
import { createExecutor } from "../src/executor.js";
import { createScheduler } from "../src/scheduler.js";
import { createPoller } from "../src/poller.js";

test("S2: 5 issues labeled at once → max 2 concurrent claude spawns at any instant", async () => {
  const root = mkdtempSync(join(tmpdir(), "hc-s2-"));
  try {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO projects(id,slug,repo,watch_label,base_branch,local_path,created_at) VALUES(1,'p','o/r','claude-dev','main',?, 't')",
    ).run(root);

    const issues = Array.from({ length: 5 }, (_, i) => ({ number: 200 + i, title: `feat${i}`, body: "go" }));
    let inFlight = 0, maxInFlight = 0;
    const fakeSpawn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { code: 0, stdout: "ok", stderr: "", timedOut: false, cancelled: false };
    };
    const claude = createClaude({
      bin: "fake",
      maxConcurrent: 2,
      minSpawnIntervalMs: 0,
      _spawn: fakeSpawn,
    });

    const gh = {
      listLabeledIssues: async () => issues,
      swapLabel: async () => {},
      comment: async () => {},
      issue: async (_repo, n) => ({ ...issues.find((i) => i.number === n), state: "OPEN" }),
      prStatus: async () => ({ state: "OPEN", number: 1, mergeStateStatus: "CLEAN" }),
      prComments: async () => [],
      viewer: async () => "bot",
      prComment: async () => {},
      openPr: async () => ({ url: "https://example/pr/1" }),
    };
    const config = {
      stageTimeoutMs: 1000,
      runCooldownMs: 0,
      runCooldownMaxMs: 0,
      keepFailedWorktree: false,
    };
    // Same plain-mock workspace shape as scenario-happy-path.test.js
    const workspace = {
      prepareClone: async () => "sha123",
      addWorktree: async (_p, run) => ({ path: `/tmp/wt-${run.id}`, branch: `claude/${run.issue_number}-p` }),
      rebaseOnBase: async () => ({ conflicted: false }),
      removeWorktree: async () => {},
    };
    const stages = {
      claude,
      runSpecPlan: async (o) => {
        await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 });
        return {};
      },
      runImplement: async (o) => { await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 }); },
      runReview: async (o) => {
        await claude.run({ cwd: o.cwd, prompt: "x", timeoutMs: 1000 });
        return { verdict: "approve" };
      },
      runPr: async ({ db, run }) => {
        db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run("https://example/pr/1", run.id);
        return { prUrl: "https://example/pr/1" };
      },
    };
    const executor = createExecutor({
      db, gh, workspace, stages,
      config, git: null,
      preview: { maybeDeployPreview: async () => {} },
      runLock: createKeyedMutex(),
    });
    const scheduler = createScheduler({ db, executor, maxConcurrentRuns: 2 });
    const poller = createPoller({ db, gh, workspace });

    await poller.tick();
    await scheduler.drain();

    assert.equal(maxInFlight, 2, `expected concurrency cap 2, saw ${maxInFlight}`);
    const open = db.prepare("SELECT COUNT(*) as c FROM runs WHERE state='pr_open'").get().c;
    assert.equal(open, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
