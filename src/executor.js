// src/executor.js
import { transition, LABEL_FOR } from "./state.js";

export function createExecutor({ db, gh, workspace, stages, decompose, config }) {
  const getRun = (id) => db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  const getProject = (pid) =>
    db.prepare("SELECT * FROM projects WHERE id=?").get(pid);

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

  async function syncCheckpoint(run, project, wtPath) {
    const r = await workspace.rebaseOnBase(project, wtPath);
    if (!r.conflicted) return;
    await stages.runResolveConflict({
      claude: stages.claude,
      cwd: wtPath,
      files: r.files || [],
      timeoutMs: config.stageTimeoutMs,
    });
  }

  async function execute(runId) {
    let run = getRun(runId);
    const project = getProject(run.project_id);
    try {
      const issue = await gh.issue(project.repo, run.issue_number);

      const baseSha = await workspace.prepareClone(project);
      const wt = await workspace.addWorktree(project, run);
      db.prepare(
        "UPDATE runs SET worktree_path=?, branch=?, last_synced_base_sha=? WHERE id=?",
      ).run(wt.path, wt.branch, baseSha, run.id);
      run = getRun(runId);

      transition(db, run.id, "spec_plan", { stage: "spec_plan", message: "start" });
      const sp = await stages.runSpecPlan({
        db, run, claude: stages.claude, issue,
        cwd: wt.path, timeoutMs: config.stageTimeoutMs,
      });

      if (sp.size === "large") {
        transition(db, run.id, "decomposing", { stage: "decomposing", message: "splitting" });
        await decompose({ db, gh, project, parentRun: run, subIssues: sp.subIssues });
        transition(db, run.id, "decomposed", { stage: "decomposing", message: "done" });
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
        run = getRun(runId);
        transition(db, run.id, "implementing", { stage: "implement", message: "start" });
        await syncCheckpoint(run, project, wt.path); // before implement
        await stages.runImplement({
          db, run, claude: stages.claude, cwd: wt.path,
          timeoutMs: config.stageTimeoutMs,
        });

        transition(db, run.id, "reviewing", { stage: "review", message: "start" });
        await syncCheckpoint(run, project, wt.path); // before review
        const rv = await stages.runReview({
          db, run, claude: stages.claude, cwd: wt.path,
          timeoutMs: config.stageTimeoutMs,
        });
        if (rv.verdict === "approve") break;
        attempts++;
        if (attempts >= 2) {
          await fail(runId, project, `review: changes still requested after retry (${rv.notes})`);
          return;
        }
      }

      const pr = await stages.runPr({
        db, run: getRun(runId), project,
        gh, issue,
      });
      transition(db, run.id, "pr_open", { stage: "pr", message: pr.prUrl });
      try {
        await gh.swapLabel(project.repo, run.issue_number, "in-progress", "pr-open");
      } catch {}
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await fail(runId, getProject(getRun(runId).project_id), reason);
    }
  }

  return { execute };
}
