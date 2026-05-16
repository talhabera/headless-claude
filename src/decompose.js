// src/decompose.js
import { hasCycle } from "./dag.js";

export async function decompose({ db, gh, project, parentRun, subIssues }) {
  if (!subIssues || subIssues.length === 0)
    throw new Error("decompose: no sub-issues proposed");
  if (hasCycle(subIssues))
    throw new Error("decompose: cyclic sub-issue dependency graph");

  // Phase A — create all sub-issues, NO labels yet
  const keyToNumber = new Map();
  const links = [];
  for (const s of subIssues) {
    const body = `${s.body || ""}\n\n_(sub-issue of #${parentRun.issue_number})_`;
    const { number } = await gh.createIssue(project.repo, {
      title: s.title,
      body,
    });
    keyToNumber.set(s.key, number);
    links.push([number, s.dependsOn || []]);
  }

  // Phase B — insert ALL issue_deps rows atomically before arming the poller
  const insDep = db.prepare(
    `INSERT OR IGNORE INTO issue_deps
     (project_id,issue_number,depends_on_issue_number) VALUES (?,?,?)`,
  );
  const insertAll = db.transaction(() => {
    for (const [number, deps] of links) {
      for (const k of deps) {
        const depNum = keyToNumber.get(k);
        if (depNum) insDep.run(project.id, number, depNum);
      }
    }
  });
  insertAll();

  // Phase C — NOW label every sub-issue (arms the poller; deps rows already exist)
  for (const [number] of links) {
    try {
      await gh.setLabel(project.repo, number, project.watch_label);
    } catch {}
  }

  // Phase D — rollup comment
  const list = subIssues
    .map((s) => `- [ ] #${keyToNumber.get(s.key)} ${s.title}` +
      (s.dependsOn?.length
        ? ` (blocked by ${s.dependsOn.map((k) => `#${keyToNumber.get(k)}`).join(", ")})`
        : ""))
    .join("\n");
  try {
    await gh.comment(
      project.repo,
      parentRun.issue_number,
      `Decomposed into sub-issues:\n\n${list}`,
    );
  } catch {}
}
