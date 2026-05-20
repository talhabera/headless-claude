// src/prSweep.js
import { recordSuccess, recordFailure } from "./runCooldown.js";

export function createPrSweep({ db, gh, workspace, stages, config, runLock, now = () => Date.now() }) {
  let running = false;

  async function tick() {
    if (running) return;            // drop overlapping firings
    running = true;
    try {
      const projects = db.prepare("SELECT * FROM projects").all();
      const nowIso = new Date(now()).toISOString();
      for (const p of projects) {
        const runs = db
          .prepare(
            `SELECT * FROM runs
               WHERE project_id=? AND state='pr_open' AND needs_attention=0
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
          )
          .all(p.id, nowIso);

        for (const r of runs) {
          await runLock.runExclusive(r.id, () => handleRun(p, r));
        }
      }
    } finally {
      running = false;
    }
  }

  async function handleRun(p, r) {
    let status;
    try {
      status = await gh.prStatus(p.repo, r.branch);
    } catch {
      return;
    }
    if (status.state !== "OPEN") return;
    const behind = ["BEHIND", "DIRTY", "UNKNOWN"].includes(status.mergeStateStatus);
    if (!behind) return;
    if (!r.worktree_path) return; // worktree gone post-PR; skip (manual)

    let claudeFailed = false;
    try {
      const rb = await workspace.rebaseOnBase(p, r.worktree_path);
      if (rb.conflicted) {
        try {
          await stages.runResolveConflict({
            claude: stages.claude,
            cwd: r.worktree_path,
            files: rb.files || [],
            timeoutMs: config.stageTimeoutMs,
          });
        } catch (e) {
          claudeFailed = true;
          try { await workspace.abortRebase(p, r.worktree_path); } catch {}
          db.prepare(
            "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
          ).run(e.message, r.id);
          try { await gh.comment(p.repo, r.issue_number, `PR rebase blocked: ${e.message}`); } catch {}
          recordFailure(db, r.id, config, now());
          return;
        }
      }
      try {
        await workspace.pushBranch(p, r.worktree_path, r.branch);
      } catch (e) {
        claudeFailed = true;
        db.prepare(
          "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
        ).run(`push failed: ${e.message}`, r.id);
        recordFailure(db, r.id, config, now());
        return;
      }
    } finally {
      if (!claudeFailed) recordSuccess(db, r.id, config, now());
    }
  }

  return { tick };
}
