// src/workspace.js
import { join } from "node:path";
import { rmSync } from "node:fs";

export function createWorkspace({ git, mutex, worktreesDir }) {
  const lock = (project, fn) => mutex.runExclusive(project.slug, fn);

  function headSha(project) {
    const r = git(project.local_path, ["rev-parse", `origin/${project.base_branch}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  return {
    headSha,
    prepareClone(project) {
      return lock(project, async () => {
        const lp = project.local_path;
        const b = project.base_branch;
        let r = git(lp, ["fetch", "origin", "--prune"]);
        if (r.code !== 0) throw new Error(`fetch failed: ${r.stderr.trim()}`);
        git(lp, ["checkout", b]);
        r = git(lp, ["reset", "--hard", `origin/${b}`]);
        if (r.code !== 0) throw new Error(`reset failed: ${r.stderr.trim()}`);
        return headSha(project);
      });
    },
    addWorktree(project, run) {
      return lock(project, async () => {
        const path = join(
          worktreesDir,
          `${project.slug}-${run.issue_number}-${run.attempt}`,
        );
        const branch = `claude/${run.issue_number}-${project.slug}`;
        const r = git(project.local_path, [
          "worktree", "add", path, "-b", branch,
          `origin/${project.base_branch}`,
        ]);
        if (r.code !== 0)
          throw new Error(`worktree add failed: ${r.stderr.trim()}`);
        return { path, branch };
      });
    },
    rebaseOnBase(project, worktreePath) {
      return lock(project, async () => {
        git(project.local_path, ["fetch", "origin", "--prune"]);
        const r = git(worktreePath, [
          "rebase",
          `origin/${project.base_branch}`,
        ]);
        if (r.code === 0) return { conflicted: false };
        const f = git(worktreePath, [
          "diff", "--name-only", "--diff-filter=U",
        ]);
        return {
          conflicted: true,
          files: f.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
        };
      });
    },
    abortRebase(project, worktreePath) {
      return lock(project, async () => {
        git(worktreePath, ["rebase", "--abort"]);
      });
    },
    pushBranch(project, worktreePath, branch) {
      return lock(project, async () => {
        const r = git(worktreePath, [
          "push", "--force-with-lease", "origin", branch,
        ]);
        if (r.code !== 0) throw new Error(`push failed: ${r.stderr.trim()}`);
      });
    },
    removeWorktree(project, path, { deleteBranch, branch } = {}) {
      return lock(project, async () => {
        git(project.local_path, ["worktree", "remove", "--force", path]);
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {}
        if (deleteBranch && branch)
          git(project.local_path, ["branch", "-D", branch]);
      });
    },
    diffFingerprint(project, worktreePath) {
      return lock(project, async () => {
        const base = project.base_branch || "main";
        // three-dot: diff against the merge-base so the fingerprint is stable when base advances / the branch is rebased
        const d = git(worktreePath, ["diff", `origin/${base}...HEAD`]);
        if (d.code !== 0) {
          throw new Error(`diff failed: ${d.stderr.trim()}`);
        }
        if (!d.stdout.trim()) return "";
        const p = git(worktreePath, ["patch-id", "--stable"], {
          input: d.stdout,
        });
        if (p.code !== 0) {
          throw new Error(`patch-id failed: ${p.stderr.trim()}`);
        }
        return (p.stdout.trim().split(/\s+/)[0]) || "";
      });
    },
    runExclusive(project, fn) {
      return lock(project, fn);
    },
  };
}
