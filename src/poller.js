// src/poller.js
import { transition } from "./state.js";

export function createPoller({ db, gh, workspace }) {
  const projects = () => db.prepare("SELECT * FROM projects").all();

  function hasActiveRun(projectId, issueNumber) {
    return !!db
      .prepare(
        `SELECT 1 FROM runs WHERE project_id=? AND issue_number=?
         AND state NOT IN ('failed','merged','decomposed')`,
      )
      .get(projectId, issueNumber);
  }

  function nextAttempt(projectId, issueNumber) {
    const r = db
      .prepare(
        "SELECT MAX(attempt) a FROM runs WHERE project_id=? AND issue_number=?",
      )
      .get(projectId, issueNumber);
    return (r.a || 0) + 1;
  }

  function depsFor(projectId, issueNumber) {
    return db
      .prepare(
        "SELECT depends_on_issue_number d FROM issue_deps WHERE project_id=? AND issue_number=?",
      )
      .all(projectId, issueNumber)
      .map((x) => x.d);
  }

  const isClosed = (iss) => iss.closed || iss.state === "CLOSED";

  async function allDepsClosed(repo, projectId, issueNumber) {
    for (const d of depsFor(projectId, issueNumber)) {
      const iss = await gh.issue(repo, d);
      if (!isClosed(iss)) return false;
    }
    return true;
  }

  async function tick() {
    for (const p of projects()) {
      // 1. enqueue newly labeled issues
      const issues = await gh.listLabeledIssues(p.repo, p.watch_label);
      for (const iss of issues) {
        try {
          if (hasActiveRun(p.id, iss.number)) continue;
          const attempt = nextAttempt(p.id, iss.number);
          const blocked = !(await allDepsClosed(p.repo, p.id, iss.number));
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at)
             VALUES (?,?,?,?,?,?)`,
          ).run(
            p.id,
            iss.number,
            blocked ? "blocked" : "queued",
            attempt,
            now,
            now,
          );
          try {
            await gh.swapLabel(p.repo, iss.number, p.watch_label, "in-progress");
          } catch {}
        } catch {}
      }

      // 2. unblock dependents whose blockers are now closed
      const blockedRuns = db
        .prepare("SELECT * FROM runs WHERE project_id=? AND state='blocked'")
        .all(p.id);
      for (const r of blockedRuns) {
        try {
          if (await allDepsClosed(p.repo, p.id, r.issue_number))
            transition(db, r.id, "queued", {
              stage: "poller",
              message: "dependencies satisfied",
            });
        } catch {}
      }

      // 3. detect merged: pr_open run whose issue is now closed
      const open = db
        .prepare("SELECT * FROM runs WHERE project_id=? AND state='pr_open'")
        .all(p.id);
      for (const r of open) {
        try {
          const iss = await gh.issue(p.repo, r.issue_number);
          if (isClosed(iss)) {
            transition(db, r.id, "merged", {
              stage: "poller",
              message: "issue closed",
            });
            if (workspace && r.worktree_path) {
              try {
                await workspace.removeWorktree(p, r.worktree_path, {
                  deleteBranch: true,
                  branch: r.branch,
                });
              } catch {}
            }
          }
        } catch {}
      }
    }
  }

  return { tick };
}
