// src/stages/pr.js
export function buildPrBody({ issueNumber, specExcerpt, checklist }) {
  const items = checklist.map((c) => `- [x] ${c}`).join("\n");
  return `## Summary

${specExcerpt}

## Acceptance criteria

${items}

Closes #${issueNumber}

---
*Opened automatically by headless-claude autonomous dev.*`;
}

export async function runPr({ db, run, project, gh, issue }) {
  const spec =
    db.prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='spec'").get(run.id)
      ?.content || "";
  const checklist = JSON.parse(
    db
      .prepare(
        "SELECT content FROM run_artifacts WHERE run_id=? AND kind='acceptance_checklist'",
      )
      .get(run.id)?.content || "[]",
  );
  const body = buildPrBody({
    issueNumber: run.issue_number,
    specExcerpt: spec.slice(0, 600),
    checklist,
  });
  const pr = await gh.createPR(project.repo, {
    head: run.branch,
    base: project.base_branch,
    title: `${issue.title} (closes #${run.issue_number})`,
    body,
  });
  db.prepare("UPDATE runs SET pr_url=? WHERE id=?").run(pr.url, run.id);
  return { prUrl: pr.url };
}
