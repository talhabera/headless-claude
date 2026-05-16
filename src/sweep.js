// src/sweep.js
// On service start, prune orphaned git worktrees and clear stale git lock files
// left by a crash. This runs AFTER reconcileOnStartup so pr_open is the only
// state that still legitimately holds a live worktree.

import { existsSync, rmSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

// Recursively collect all *.lock files under a directory.
function collectLockFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          results.push(...collectLockFiles(full));
        } else if (entry.endsWith(".lock")) {
          results.push(full);
        }
      } catch {
        // ignore stat errors
      }
    }
  } catch {
    // ignore readdir errors
  }
  return results;
}

// Parse `git worktree list --porcelain` output into an array of absolute paths.
function parsePorcelainPaths(stdout) {
  const paths = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

export function sweepWorkspacesOnStartup({ db, git, config }) {
  let prunedWorktrees = 0;
  let clearedLocks = 0;

  // 1. Compute the LIVE set: only pr_open runs keep their worktree across restart.
  const live = new Set(
    db
      .prepare(
        "SELECT worktree_path FROM runs WHERE state='pr_open' AND worktree_path IS NOT NULL"
      )
      .all()
      .map((r) => r.worktree_path)
  );

  const projects = db.prepare("SELECT * FROM projects").all();

  // 2. Per-project sweep.
  for (const p of projects) {
    try {
      const clone = p.local_path;

      // 2a. Skip project if clone dir doesn't exist.
      if (!existsSync(clone)) continue;

      // 2b. Registered-worktree prune.
      const listResult = git(clone, ["worktree", "list", "--porcelain"]);
      const registeredPaths = parsePorcelainPaths(listResult.stdout);

      for (const wtPath of registeredPaths) {
        // Skip the clone itself.
        if (wtPath === clone) continue;
        // Only touch paths under config.worktreesDir.
        if (!wtPath.startsWith(config.worktreesDir)) continue;
        // Keep live pr_open worktrees.
        if (live.has(wtPath)) continue;

        // Prune this stale registered worktree.
        try {
          git(clone, ["worktree", "remove", "--force", wtPath]);
        } catch {
          // ignore git errors — rmSync below is best-effort
        }
        try {
          rmSync(wtPath, { recursive: true, force: true });
        } catch {
          // ignore
        }
        prunedWorktrees++;
      }

      // 2c. Prune stale worktree metadata from git's tracking.
      try {
        git(clone, ["worktree", "prune"]);
      } catch {
        // ignore
      }

      // 2d. Stale-lock sweep for this clone's git dir.
      const gd = join(clone, ".git");
      if (existsSync(gd)) {
        // Top-level lock files.
        for (const name of ["index.lock", "HEAD.lock", "config.lock"]) {
          const lockPath = join(gd, name);
          try {
            unlinkSync(lockPath);
            clearedLocks++;
          } catch {
            // ignore — file may not exist
          }
        }

        // Every *.lock under refs/ (if it exists).
        const refsDir = join(gd, "refs");
        if (existsSync(refsDir)) {
          for (const lockPath of collectLockFiles(refsDir)) {
            try {
              unlinkSync(lockPath);
              clearedLocks++;
            } catch {
              // ignore
            }
          }
        }

        // Per-worktree lock files under worktrees/.
        const worktreesMetaDir = join(gd, "worktrees");
        if (existsSync(worktreesMetaDir)) {
          let subdirs = [];
          try {
            subdirs = readdirSync(worktreesMetaDir);
          } catch {
            // ignore
          }
          for (const d of subdirs) {
            for (const name of ["index.lock", "HEAD.lock"]) {
              const lockPath = join(worktreesMetaDir, d, name);
              try {
                unlinkSync(lockPath);
                clearedLocks++;
              } catch {
                // ignore
              }
            }
          }
        }
      }
    } catch {
      // Defensive: one bad project must not abort the rest.
    }
  }

  // 3. Unregistered leftover dirs in worktreesDir.
  if (existsSync(config.worktreesDir)) {
    // Build set of all clone paths so we don't accidentally remove them.
    const clonePaths = new Set(projects.map((p) => p.local_path));

    let entries = [];
    try {
      entries = readdirSync(config.worktreesDir);
    } catch {
      // ignore
    }

    for (const e of entries) {
      const full = join(config.worktreesDir, e);
      try {
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          // ignore
        }
        if (!isDir) continue;
        if (live.has(full)) continue;
        if (clonePaths.has(full)) continue;

        try {
          rmSync(full, { recursive: true, force: true });
        } catch {
          // ignore
        }
        // Note: we don't increment prunedWorktrees here because these are
        // unregistered leftovers (not tracked by git worktree), but they are
        // cleaned up as part of the sweep.
      } catch {
        // ignore
      }
    }
  }

  return { prunedWorktrees, clearedLocks };
}
