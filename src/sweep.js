// src/sweep.js
// On service start, prune orphaned git worktrees and clear stale git lock files
// left by a crash. This runs AFTER reconcileOnStartup so pr_open is the only
// state that still legitimately holds a live worktree.
//
// SAFETY: git worktree --porcelain returns canonicalized realpaths while DB
// columns store raw path.join strings, and config.worktreesDir may be
// symlinked/relative/empty. All path comparisons are done on normalized
// (realpath-resolved) values on BOTH sides, with boundary-aware containment,
// so a live pr_open worktree or the clone is never misclassified and deleted.

import {
  existsSync,
  rmSync,
  readdirSync,
  unlinkSync,
  statSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join, isAbsolute, resolve, sep } from "node:path";

// Guarded normalizer: resolve to realpath when possible (collapses symlinks),
// fall back to path.resolve, finally to the raw value. Never throws.
const norm = (p) => {
  try {
    return realpathSync(p);
  } catch {
    try {
      return resolve(p);
    } catch {
      return p;
    }
  }
};

// Boundary-aware containment: true iff `candN` is strictly under `wtDirN`
// (not equal to it, and not a sibling that merely shares a string prefix).
function isUnder(candN, wtDirN) {
  if (candN === wtDirN) return false;
  const base = wtDirN.replace(/[\/\\]+$/, "") + sep;
  return (candN + sep).startsWith(base);
}

// Recursively collect all *.lock files under a directory. Never follows
// symlinks (lstat) so the walk cannot escape the .git directory.
function collectLockFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          results.push(...collectLockFiles(full));
        } else if (entry.endsWith(".lock")) {
          results.push(full);
        }
      } catch {
        // ignore lstat errors
      }
    }
  } catch {
    // ignore readdir errors
  }
  return results;
}

// Parse NUL-delimited `git worktree list --porcelain -z` output into an array
// of absolute paths. The -z form has no C-quoting and is CRLF-safe. Tolerant
// of empty/garbage stdout.
function parsePorcelainPaths(stdout) {
  const paths = [];
  if (!stdout || typeof stdout !== "string") return paths;
  for (const field of stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      const p = field.slice("worktree ".length).trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

export function sweepWorkspacesOnStartup({ db, git, config }) {
  let prunedWorktrees = 0;
  let clearedLocks = 0;
  let removedLeftovers = 0;

  // 1. Validate worktreesDir: must be a non-empty absolute string, else no-op.
  if (
    !config ||
    !config.worktreesDir ||
    typeof config.worktreesDir !== "string" ||
    !isAbsolute(config.worktreesDir)
  ) {
    return { prunedWorktrees: 0, clearedLocks: 0, removedLeftovers: 0 };
  }

  const wtDirN = norm(config.worktreesDir);

  // 2/3. Live set (normalized) — only pr_open runs keep a worktree across
  // restart. Clone set (normalized) — clones must never be deletion targets.
  const live = new Set(
    db
      .prepare(
        "SELECT worktree_path FROM runs WHERE state='pr_open' AND worktree_path IS NOT NULL"
      )
      .all()
      .map((r) => norm(r.worktree_path))
  );

  const projects = db.prepare("SELECT * FROM projects").all();
  const cloneSet = new Set(projects.map((r) => norm(r.local_path)));

  // Decide whether a normalized candidate path is a safe deletion target:
  // it must be strictly under worktreesDir and must NOT be a clone or live.
  const isSafeTarget = (candN, cloneN) =>
    candN !== cloneN &&
    candN !== wtDirN &&
    !cloneSet.has(candN) &&
    !live.has(candN) &&
    isUnder(candN, wtDirN);

  // 2. Per-project sweep.
  for (const p of projects) {
    try {
      const clone = p.local_path;

      // 2a. Skip project if clone dir doesn't exist.
      if (!existsSync(clone)) continue;

      const cloneN = norm(clone);

      // 2b. Registered-worktree prune (NUL-delimited porcelain).
      const listResult =
        git(clone, ["worktree", "list", "--porcelain", "-z"]) || {};
      const registeredPaths = parsePorcelainPaths(listResult.stdout);

      for (const wtPath of registeredPaths) {
        const candN = norm(wtPath);

        // Never touch the clone, worktreesDir itself, any clone, or live.
        if (candN === cloneN) continue;
        if (cloneSet.has(candN)) continue;
        if (live.has(candN)) continue;

        // Only remove paths strictly under worktreesDir (boundary-aware).
        if (!isSafeTarget(candN, cloneN)) continue;

        // Prune this stale registered worktree.
        let removeCode = 1;
        try {
          const r = git(clone, ["worktree", "remove", "--force", wtPath]) || {};
          removeCode = r.code;
        } catch {
          // ignore git errors
        }

        // Only rmSync if git removal succeeded OR we can prove it's an
        // orphan (under worktreesDir, not clone, not live — established above
        // by isSafeTarget). isSafeTarget already proves orphan-ness here.
        const provablyOrphan = isSafeTarget(candN, cloneN);
        if (removeCode === 0 || provablyOrphan) {
          try {
            rmSync(wtPath, { recursive: true, force: true });
          } catch {
            // ignore
          }
          prunedWorktrees++;
        }
        // else: git failed AND not provably orphan → skip, do not count.
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
          // lstat: do not follow symlinks; only sweep real directories.
          isDir = lstatSync(full).isDirectory();
        } catch {
          // ignore
        }
        if (!isDir) continue;

        const candN = norm(full);

        // Never remove the worktreesDir itself, any clone, or live worktrees.
        if (candN === wtDirN) continue;
        if (cloneSet.has(candN)) continue;
        if (live.has(candN)) continue;
        // Must be strictly under worktreesDir (boundary-aware).
        if (!isUnder(candN, wtDirN)) continue;

        try {
          rmSync(full, { recursive: true, force: true });
          removedLeftovers++;
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    }
  }

  return { prunedWorktrees, clearedLocks, removedLeftovers };
}
