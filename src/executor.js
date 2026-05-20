// src/executor.js
import { transition, LABEL_FOR } from "./state.js";
import { recordSuccess, recordFailure } from "./runCooldown.js";

export function createExecutor({ db, gh, workspace, stages, decompose, config, git, preview, runLock, now = () => Date.now() }) {
  const getRun = (id) => db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  const getProject = (pid) =>
    db.prepare("SELECT * FROM projects WHERE id=?").get(pid);

  const active = new Map(); // runId -> AbortController

  function ensureNotCancelled(ac) {
    if (ac.signal.aborted) throw new Error("cancelled by user");
  }

  // Reject as soon as the run is cancelled, even if `p` never settles
  // (e.g. a workspace op hangs). Stage runners observe the signal directly;
  // this covers the gaps between/around them.
  function raceAbort(ac, p) {
    if (ac.signal.aborted) return Promise.reject(new Error("cancelled by user"));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("cancelled by user"));
      ac.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(p).then(
        (v) => {
          ac.signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          ac.signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  async function fail(runId, project, reason) {
    const run = getRun(runId);
    db.prepare("UPDATE runs SET fail_reason=? WHERE id=?").run(reason, run.id);
    transition(db, run.id, "failed", { stage: "executor", level: "error", message: reason });
    try {
      await gh.swapLabel(
        project.repo,
        run.issue_number,
        LABEL_FOR[run.state] || project.watch_label,
        "failed",
      );
    } catch {}
    try {
      await gh.comment(
        project.repo,
        run.issue_number,
        `Autonomous run failed: ${reason}`,
      );
    } catch {}
    if (run.worktree_path && !config.keepFailedWorktree) {
      try {
        await workspace.removeWorktree(project, run.worktree_path, {});
      } catch {}
    }
  }

  async function syncCheckpoint(run, project, wtPath, ac) {
    ensureNotCancelled(ac);
    const signal = ac.signal;
    const r = await raceAbort(ac, workspace.rebaseOnBase(project, wtPath));
    if (!r.conflicted) return;
    await stages.runResolveConflict({
      claude: stages.claude,
      cwd: wtPath,
      files: r.files || [],
      timeoutMs: config.stageTimeoutMs,
      signal,
    });
  }

  async function execute(runId) {
    return runLock.runExclusive(runId, async () => {
    const ac = new AbortController();
    active.set(runId, ac);
    let success = false;
    try {
      let run = getRun(runId);
      const project = getProject(run.project_id);
      try {
        ensureNotCancelled(ac);
        const issue = await raceAbort(ac, gh.issue(project.repo, run.issue_number));
        ensureNotCancelled(ac);

        const baseSha = await raceAbort(ac, workspace.prepareClone(project));
        ensureNotCancelled(ac);
        const wt = await raceAbort(ac, workspace.addWorktree(project, run));
        ensureNotCancelled(ac);
        db.prepare(
          "UPDATE runs SET worktree_path=?, branch=?, last_synced_base_sha=? WHERE id=?",
        ).run(wt.path, wt.branch, baseSha, run.id);
        run = getRun(runId);

        transition(db, run.id, "spec_plan", { stage: "spec_plan", message: "start" });
        const sp = await stages.runSpecPlan({
          db, run, claude: stages.claude, issue,
          cwd: wt.path, timeoutMs: config.stageTimeoutMs,
          signal: ac.signal,
        });

        if (sp.size === "large") {
          transition(db, run.id, "decomposing", { stage: "decomposing", message: "splitting" });
          await decompose({ db, gh, project, parentRun: run, subIssues: sp.subIssues });
          transition(db, run.id, "decomposed", { stage: "decomposing", message: "done" });
          success = true;
          try {
            await gh.swapLabel(project.repo, run.issue_number, "in-progress", "decomposed");
          } catch {}
          try {
            await workspace.removeWorktree(project, wt.path, {});
          } catch {}
          return;
        }

        let attempts = 0;
        while (true) {
          ensureNotCancelled(ac);
          run = getRun(runId);
          transition(db, run.id, "implementing", { stage: "implement", message: "start" });
          await syncCheckpoint(run, project, wt.path, ac); // before implement
          await stages.runImplement({
            db, run, claude: stages.claude, cwd: wt.path,
            timeoutMs: config.stageTimeoutMs,
            signal: ac.signal,
          });

          transition(db, run.id, "reviewing", { stage: "review", message: "start" });
          await syncCheckpoint(run, project, wt.path, ac); // before review
          const rv = await stages.runReview({
            db, run, claude: stages.claude, cwd: wt.path,
            timeoutMs: config.stageTimeoutMs,
            signal: ac.signal,
          });
          if (rv.verdict === "approve") break;
          attempts++;
          if (attempts >= 2) {
            await fail(runId, project, `review: changes still requested after retry (${rv.notes})`);
            return;
          }
        }

        // preview-deploy gate (required but tolerant): only if configured
        const proj = getProject(run.project_id); // current row, has preview_branch/preview_url
        if (proj.preview_branch && proj.preview_url) {
          ensureNotCancelled(ac);
          transition(db, run.id, "previewing", { stage: "previewing", message: "start" });
          try {
            const m = await raceAbort(ac, workspace.runExclusive(proj, () =>
              preview.mergeToPreview({ git, project: proj, runBranch: run.branch }),
            ));
            if (!m.ok) {
              transition(db, run.id, "previewing", { stage: "previewing", level: "warn",
                message: `preview merge skipped (${m.step}: ${m.reason || ""})` });
            } else {
              const d = await raceAbort(ac, preview.pollUrl(proj.preview_url, {
                timeoutMs: config.previewDeployTimeoutMs,
                pollMs: config.previewPollMs,
              }));
              transition(db, run.id, "previewing", { stage: "previewing",
                level: d.ok ? "info" : "warn",
                message: d.ok ? `preview live ${d.status} in ${d.elapsedMs}ms`
                               : `preview not confirmed: ${d.reason}` });
            }
          } catch (e) {
            if (ac.signal.aborted) throw e; // cancel must NOT be tolerated — escalate to outer catch
            transition(db, run.id, "previewing", { stage: "previewing", level: "warn",
              message: `preview step error (tolerated): ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        // then proceed to runPr (base branch = project.base_branch, unchanged)

        ensureNotCancelled(ac);
        const pr = await stages.runPr({
          db, run: getRun(runId), project,
          gh, issue,
        });
        transition(db, run.id, "pr_open", { stage: "pr", message: pr.prUrl });
        success = true;
        try {
          await gh.swapLabel(project.repo, run.issue_number, "in-progress", "pr-open");
        } catch {}
      } catch (e) {
        const reason = ac.signal.aborted
          ? "cancelled by user"
          : (e instanceof Error ? e.message : String(e));
        await fail(runId, getProject(getRun(runId).project_id), reason);
      }
    } finally {
      if (success) recordSuccess(db, runId, config, now());
      else recordFailure(db, runId, config, now());
      active.delete(runId);
    }
    });
  }

  function cancel(runId) {
    if (!Number.isInteger(runId)) return { cancelled: false, killed: false };
    const ac = active.get(runId);
    if (ac && !ac.signal.aborted) {
      ac.abort();
      return { cancelled: true, killed: true };
    }
    // Run not actively executing — directly mark it failed if it exists and is non-terminal
    const run = getRun(runId);
    if (run) {
      db.prepare(
        "UPDATE runs SET state='failed', fail_reason='cancelled by user', updated_at=? WHERE id=? AND state NOT IN ('failed','merged','decomposed','pr_open')",
      ).run(new Date().toISOString(), runId);
    }
    return { cancelled: true, killed: false };
  }

  return { execute, cancel };
}
