// src/stages/specPlan.js
import { parseResultBlock } from "./parse.js";

function saveArtifact(db, runId, kind, content) {
  db.prepare(
    `INSERT INTO run_artifacts (run_id,kind,content) VALUES (?,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET content=excluded.content`,
  ).run(runId, kind, content);
}

export function buildSpecPlanPrompt(issue) {
  return `You are developing GitHub issue #${issue.number}: "${issue.title}".

Issue body:
${issue.body || "(empty)"}

Use the superpowers brainstorming + writing-plans approach to produce a spec
and a phased implementation plan for THIS repository (you are in its worktree).
Extract explicit acceptance criteria as a checklist. Then judge whether the
issue is small enough to implement as a single PR, or large enough that it
must be split into independent, dependency-ordered sub-issues.

Run a self-review of the spec+plan (placeholders, contradictions, ambiguity,
scope). If it does not pass, set selfReviewPassed=false.

If large, propose subIssues as a DAG: each item {key,title,body,dependsOn:[keys]}.

Output ONLY this block at the end:
<<<RESULT
{"size":"small|large","spec":"<spec markdown>","plan":"<plan markdown>",
"acceptanceChecklist":["..."],"selfReviewPassed":true|false,
"subIssues":[{"key":"a","title":"...","body":"...","dependsOn":[]}]}
RESULT>>>`;
}

export async function runSpecPlan({ db, run, claude, issue, cwd, timeoutMs }) {
  const res = await claude.run({
    cwd,
    prompt: buildSpecPlanPrompt(issue),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("spec_plan: timed out");
  if (res.code !== 0)
    throw new Error(`spec_plan: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.selfReviewPassed)
    throw new Error("spec_plan: self-review did not pass");
  saveArtifact(db, run.id, "spec", parsed.spec || "");
  saveArtifact(db, run.id, "plan", parsed.plan || "");
  saveArtifact(
    db,
    run.id,
    "acceptance_checklist",
    JSON.stringify(parsed.acceptanceChecklist || []),
  );
  return {
    size: parsed.size === "large" ? "large" : "small",
    subIssues: parsed.subIssues || [],
  };
}
