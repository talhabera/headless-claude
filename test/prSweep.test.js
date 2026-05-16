// test/prSweep.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createPrSweep } from "../src/prSweep.js";

function seed(db) {
  db.prepare(
    "INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at) VALUES ('o-r','o/r','/c','claude-dev','main','t')",
  ).run();
  db.prepare(
    "INSERT INTO runs (project_id,issue_number,state,branch,worktree_path,pr_url,attempt,created_at,updated_at) VALUES (1,8,'pr_open','claude/8-o-r','/wt','https://github.com/o/r/pull/8',1,'t','t')",
  ).run();
}

test("BEHIND clean PR is rebased and force-pushed", async () => {
  const db = openDb(":memory:");
  seed(db);
  let pushed = false;
  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "BEHIND" }),
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: false }),
    pushBranch: async () => (pushed = true),
  };
  const sweep = createPrSweep({ db, gh, workspace, stages: {}, config: { stageTimeoutMs: 10 } });
  await sweep.tick();
  assert.equal(pushed, true);
});

test("conflicting PR runs resolve stage then pushes", async () => {
  const db = openDb(":memory:");
  seed(db);
  let resolved = false;
  let pushed = false;
  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY" }),
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: true, files: ["a.js"] }),
    pushBranch: async () => (pushed = true),
  };
  const stages = {
    runResolveConflict: async () => {
      resolved = true;
      return { resolved: true };
    },
  };
  const sweep = createPrSweep({ db, gh, workspace, stages, config: { stageTimeoutMs: 10 } });
  await sweep.tick();
  assert.equal(resolved, true);
  assert.equal(pushed, true);
});

test("unresolvable conflict flags needs_attention, no push", async () => {
  const db = openDb(":memory:");
  seed(db);
  let pushed = false;
  const gh = {
    prStatus: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY" }),
    comment: async () => {},
  };
  const workspace = {
    rebaseOnBase: async () => ({ conflicted: true, files: ["a.js"] }),
    pushBranch: async () => (pushed = true),
    abortRebase: async () => {},
  };
  const stages = {
    runResolveConflict: async () => {
      throw new Error("rebase-resolve: semantic conflict");
    },
  };
  const sweep = createPrSweep({ db, gh, workspace, stages, config: { stageTimeoutMs: 10 } });
  await sweep.tick();
  assert.equal(pushed, false);
  const r = db.prepare("SELECT needs_attention, attention_reason FROM runs WHERE issue_number=8").get();
  assert.equal(r.needs_attention, 1);
  assert.match(r.attention_reason, /rebase-resolve/);
});
