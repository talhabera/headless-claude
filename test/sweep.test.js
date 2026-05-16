// test/sweep.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { sweepWorkspacesOnStartup } from "../src/sweep.js";

// Build a fake git that records calls and returns scripted responses.
function makeFakeGit(porcelainResponses = {}) {
  const calls = [];
  const git = (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    const key = args.join(" ");
    if (key === "worktree list --porcelain -z") {
      const output = porcelainResponses[cwd] || "";
      return { code: 0, stdout: output, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "remove" && args[2] === "--force") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (key === "worktree prune") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  git.calls = calls;
  git.hasCall = (fn) => calls.some(fn);
  return git;
}

// Build NUL-delimited `git worktree list --porcelain -z` output. Each record's
// fields are NUL-separated and the record ends with a double NUL.
function porcelain(paths) {
  return paths
    .map((p) => `worktree ${p}\0HEAD abc123\0branch refs/heads/main\0\0`)
    .join("");
}

test("orphan registered worktree pruned, live pr_open kept", () => {
  const db = openDb(":memory:");
  const worktreesDir = mkdtempSync(join(tmpdir(), "hc-wt-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "hc-clone-"));
  // Create .git dir inside clone to simulate a real clone
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  // Create worktree dirs on disk
  const orphanPath = join(worktreesDir, "o-r-8-1");
  const livePath = join(worktreesDir, "o-r-9-1");
  mkdirSync(orphanPath, { recursive: true });
  mkdirSync(livePath, { recursive: true });

  // Insert project
  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  // Insert live run with pr_open state
  db.prepare(
    `INSERT INTO runs (project_id, issue_number, state, worktree_path, created_at, updated_at)
     VALUES (1, 9, 'pr_open', ?, '2024-01-01', '2024-01-01')`
  ).run(livePath);

  const git = makeFakeGit({
    [cloneDir]: porcelain([cloneDir, orphanPath, livePath]),
  });

  const config = { worktreesDir };

  const result = sweepWorkspacesOnStartup({ db, git, config });

  // Orphan dir should be gone
  assert.ok(!existsSync(orphanPath), "orphan worktree dir should be removed");

  // Live dir should still exist
  assert.ok(existsSync(livePath), "live pr_open worktree dir should be kept");

  // git worktree remove --force was called for orphan
  assert.ok(
    git.hasCall(({ args }) =>
      args[0] === "worktree" &&
      args[1] === "remove" &&
      args[2] === "--force" &&
      args[3] === orphanPath
    ),
    "git worktree remove --force should be called for orphan"
  );

  // git worktree remove --force was NOT called for live path
  assert.ok(
    !git.hasCall(({ args }) =>
      args[0] === "worktree" &&
      args[1] === "remove" &&
      args[2] === "--force" &&
      args[3] === livePath
    ),
    "git worktree remove --force should NOT be called for live path"
  );

  // git worktree prune was called
  assert.ok(
    git.hasCall(({ args }) => args.join(" ") === "worktree prune"),
    "git worktree prune should be called"
  );

  // Result is a summary object
  assert.ok(typeof result === "object" && result !== null, "should return summary object");
  assert.ok(typeof result.prunedWorktrees === "number", "summary has prunedWorktrees count");
  assert.ok(typeof result.clearedLocks === "number", "summary has clearedLocks count");
});

test("stale locks cleared", () => {
  const db = openDb(":memory:");
  const worktreesDir = mkdtempSync(join(tmpdir(), "hc-wt-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "hc-clone-"));
  const gitDir = join(cloneDir, ".git");

  // Create .git directory structure
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  mkdirSync(join(gitDir, "worktrees", "o-r-8-1"), { recursive: true });

  // Create lock files
  writeFileSync(join(gitDir, "index.lock"), "lock");
  writeFileSync(join(gitDir, "HEAD.lock"), "lock");
  writeFileSync(join(gitDir, "refs", "heads", "main.lock"), "lock");
  writeFileSync(join(gitDir, "worktrees", "o-r-8-1", "index.lock"), "lock");
  writeFileSync(join(gitDir, "worktrees", "o-r-8-1", "HEAD.lock"), "lock");

  // Create a non-lock file that should NOT be removed
  writeFileSync(join(gitDir, "refs", "heads", "main"), "abc123\n");

  // Insert project
  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  const git = makeFakeGit({
    [cloneDir]: porcelain([cloneDir]),
  });

  const config = { worktreesDir };

  const result = sweepWorkspacesOnStartup({ db, git, config });

  // All lock files should be gone
  assert.ok(!existsSync(join(gitDir, "index.lock")), "index.lock should be removed");
  assert.ok(!existsSync(join(gitDir, "HEAD.lock")), "HEAD.lock should be removed");
  assert.ok(!existsSync(join(gitDir, "refs", "heads", "main.lock")), "refs/heads/main.lock should be removed");
  assert.ok(!existsSync(join(gitDir, "worktrees", "o-r-8-1", "index.lock")), "worktrees/o-r-8-1/index.lock should be removed");
  assert.ok(!existsSync(join(gitDir, "worktrees", "o-r-8-1", "HEAD.lock")), "worktrees/o-r-8-1/HEAD.lock should be removed");

  // Non-lock file should still exist
  assert.ok(existsSync(join(gitDir, "refs", "heads", "main")), "non-lock file should NOT be removed");

  // Summary should count cleared locks
  assert.ok(result.clearedLocks >= 5, `should have cleared at least 5 locks, got ${result.clearedLocks}`);
});

test("unregistered leftover dir removed, pr_open dir kept", () => {
  const db = openDb(":memory:");
  const worktreesDir = mkdtempSync(join(tmpdir(), "hc-wt-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "hc-clone-"));
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  // Create dirs in worktreesDir
  const strayPath = join(worktreesDir, "o-r-3-1");
  const livePath = join(worktreesDir, "o-r-9-1");
  mkdirSync(strayPath, { recursive: true });
  mkdirSync(livePath, { recursive: true });

  // Insert project
  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  // Insert live pr_open run pointing to livePath
  db.prepare(
    `INSERT INTO runs (project_id, issue_number, state, worktree_path, created_at, updated_at)
     VALUES (1, 9, 'pr_open', ?, '2024-01-01', '2024-01-01')`
  ).run(livePath);

  // Porcelain only lists clone (strayPath and livePath are unregistered)
  const git = makeFakeGit({
    [cloneDir]: porcelain([cloneDir]),
  });

  const config = { worktreesDir };

  sweepWorkspacesOnStartup({ db, git, config });

  // Stray dir should be gone (not in porcelain, not a live run)
  assert.ok(!existsSync(strayPath), "stray dir should be removed");

  // Live dir should still exist (it's a pr_open run)
  assert.ok(existsSync(livePath), "live pr_open dir should be kept");
});

test("defensive: missing local_path is skipped without throwing", () => {
  const db = openDb(":memory:");
  const worktreesDir = mkdtempSync(join(tmpdir(), "hc-wt-"));

  // Insert project with a non-existent local_path
  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', '/nonexistent/path/that/does/not/exist', 'dev', 'main', '2024-01-01')`
  ).run();

  const git = makeFakeGit({});
  const config = { worktreesDir };

  let result;
  let threw = false;
  try {
    result = sweepWorkspacesOnStartup({ db, git, config });
  } catch {
    threw = true;
  }

  assert.ok(!threw, "sweepWorkspacesOnStartup should not throw");
  assert.ok(result !== undefined, "should return a result object");
  assert.ok(typeof result.prunedWorktrees === "number", "result.prunedWorktrees is a number");
  assert.ok(typeof result.clearedLocks === "number", "result.clearedLocks is a number");
});

// ---------------------------------------------------------------------------
// Adversarial / data-loss safety tests
// ---------------------------------------------------------------------------

test("clone located UNDER worktreesDir is never removed", () => {
  const db = openDb(":memory:");
  const worktreesDir = mkdtempSync(join(tmpdir(), "hc-wt-"));

  // The clone itself lives under worktreesDir (a misconfiguration, but the
  // sweep must NEVER delete a registered clone).
  const cloneDir = join(worktreesDir, "theclone");
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  // No pr_open run. Porcelain lists only the clone (realpath form).
  const git = makeFakeGit({
    [cloneDir]: porcelain([realpathSync(cloneDir)]),
  });
  const config = { worktreesDir };

  sweepWorkspacesOnStartup({ db, git, config });

  assert.ok(existsSync(cloneDir), "clone dir under worktreesDir must be kept");
  assert.ok(
    !git.hasCall(
      ({ args }) =>
        args[0] === "worktree" &&
        args[1] === "remove" &&
        (args[3] === cloneDir || args[3] === realpathSync(worktreesDir + "/theclone"))
    ),
    "git worktree remove must NOT be called for the clone"
  );
});

test("symlinked worktreesDir preserves a live pr_open worktree", (t) => {
  const db = openDb(":memory:");
  const realWtDir = mkdtempSync(join(tmpdir(), "hc-realwt-"));
  const linkParent = mkdtempSync(join(tmpdir(), "hc-link-"));
  const symWtDir = join(linkParent, "wtlink");

  try {
    symlinkSync(realWtDir, symWtDir);
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") {
      t.skip("symlink creation not permitted in this environment");
      return;
    }
    throw e;
  }

  const cloneDir = mkdtempSync(join(tmpdir(), "hc-clone-"));
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  // Live worktree dir physically under the REAL dir.
  const liveReal = join(realWtDir, "o-r-9-1");
  mkdirSync(liveReal, { recursive: true });
  // The symlink-form path that the DB stores.
  const liveSym = join(symWtDir, "o-r-9-1");

  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  // Run stores the symlink-form worktree_path.
  db.prepare(
    `INSERT INTO runs (project_id, issue_number, state, worktree_path, created_at, updated_at)
     VALUES (1, 9, 'pr_open', ?, '2024-01-01', '2024-01-01')`
  ).run(liveSym);

  // Fake porcelain returns the REALPATH form (what real git would print).
  const git = makeFakeGit({
    [cloneDir]: porcelain([realpathSync(cloneDir), realpathSync(liveReal)]),
  });

  // config.worktreesDir points at the SYMLINK.
  const config = { worktreesDir: symWtDir };

  sweepWorkspacesOnStartup({ db, git, config });

  assert.ok(existsSync(liveReal), "live pr_open worktree must still exist");
  assert.ok(
    !git.hasCall(
      ({ args }) =>
        args[0] === "worktree" &&
        args[1] === "remove" &&
        (args[3] === realpathSync(liveReal) || args[3] === liveSym)
    ),
    "git worktree remove must NOT target the live worktree"
  );
});

test("empty/undefined worktreesDir is a no-op", () => {
  const db = openDb(":memory:");
  const cloneDir = mkdtempSync(join(tmpdir(), "hc-clone-"));
  mkdirSync(join(cloneDir, ".git"), { recursive: true });
  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  for (const bad of ["", undefined, "relative/path"]) {
    const git = makeFakeGit({});
    let result;
    let threw = false;
    try {
      result = sweepWorkspacesOnStartup({ db, git, config: { worktreesDir: bad } });
    } catch {
      threw = true;
    }
    assert.ok(!threw, `must not throw for worktreesDir=${JSON.stringify(bad)}`);
    assert.deepEqual(
      result,
      { prunedWorktrees: 0, clearedLocks: 0, removedLeftovers: 0 },
      `zeroed summary for worktreesDir=${JSON.stringify(bad)}`
    );
    // Nothing executed: no git calls at all.
    assert.equal(git.calls.length, 0, "no git calls for invalid worktreesDir");
  }
});

test("sibling-prefix dir is untouched", () => {
  const db = openDb(":memory:");
  // worktreesDir and a sibling that shares its string prefix: "<wt>-evil".
  const baseTmp = mkdtempSync(join(tmpdir(), "hc-base-"));
  const worktreesDir = join(baseTmp, "wt");
  const evilSibling = join(baseTmp, "wt-evil");
  mkdirSync(worktreesDir, { recursive: true });
  const evilPath = join(evilSibling, "x");
  mkdirSync(evilPath, { recursive: true });

  const cloneDir = mkdtempSync(join(tmpdir(), "hc-clone-"));
  mkdirSync(join(cloneDir, ".git"), { recursive: true });

  db.prepare(
    `INSERT INTO projects (slug, repo, local_path, watch_label, base_branch, created_at)
     VALUES ('o-r', 'o/r', ?, 'dev', 'main', '2024-01-01')`
  ).run(cloneDir);

  // Porcelain lists the clone plus a worktree at the sibling-prefix path.
  const git = makeFakeGit({
    [cloneDir]: porcelain([realpathSync(cloneDir), realpathSync(evilPath)]),
  });
  const config = { worktreesDir };

  sweepWorkspacesOnStartup({ db, git, config });

  assert.ok(existsSync(evilPath), "sibling-prefix dir must NOT be removed");
  assert.ok(
    !git.hasCall(
      ({ args }) =>
        args[0] === "worktree" &&
        args[1] === "remove" &&
        (args[3] === evilPath || args[3] === realpathSync(evilPath))
    ),
    "git worktree remove must NOT target the sibling-prefix path"
  );
});
