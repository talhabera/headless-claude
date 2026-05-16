// src/prSweep.js
export function createPrSweep({ db, gh, workspace, stages, config }) {
  async function tick() {
    const projects = db.prepare("SELECT * FROM projects").all();
    for (const p of projects) {
      const runs = db
        .prepare(
          "SELECT * FROM runs WHERE project_id=? AND state='pr_open' AND needs_attention=0",
        )
        .all(p.id);
      for (const r of runs) {
        let status;
        try {
          status = await gh.prStatus(p.repo, r.branch);
        } catch {
          continue;
        }
        if (status.state !== "OPEN") continue;
        const behind = ["BEHIND", "DIRTY", "UNKNOWN"].includes(
          status.mergeStateStatus,
        );
        if (!behind) continue;
        if (!r.worktree_path) continue; // worktree gone post-PR; skip (manual)

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
            try {
              await workspace.abortRebase(p, r.worktree_path);
            } catch {}
            db.prepare(
              "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
            ).run(e.message, r.id);
            try {
              await gh.comment(
                p.repo,
                r.issue_number,
                `PR rebase blocked: ${e.message}`,
              );
            } catch {}
            continue;
          }
        }
        try {
          await workspace.pushBranch(p, r.worktree_path, r.branch);
        } catch (e) {
          db.prepare(
            "UPDATE runs SET needs_attention=1, attention_reason=? WHERE id=?",
          ).run(`push failed: ${e.message}`, r.id);
        }
      }
    }
  }
  return { tick };
}
