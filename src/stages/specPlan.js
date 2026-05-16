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

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr create\`, \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run the project's tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Creating a PR or pushing yourself will produce a duplicate/wrong-base PR and is a hard error.

Use the superpowers brainstorming + writing-plans approach to produce a spec
and a phased implementation plan for THIS repository (you are in its worktree).
Extract explicit acceptance criteria as a checklist. Then judge whether the
issue is small enough to implement as a single PR, or large enough that it
must be split into independent, dependency-ordered sub-issues.

The spec AND the acceptanceChecklist MUST capture, verbatim, every explicit
convention, constraint, and stack rule stated in the issue (for example:
"strings live in messages/{tr,en,ru}.json, never hardcode", file/location
mandates, "no behavior change") as explicit checklist items so that later
stages can enforce them. Any convention stated in the issue body must appear
as a distinct item in the acceptanceChecklist — not just in prose.

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

export async function runSpecPlan({ db, run, claude, issue, cwd, timeoutMs, signal }) {
  const res = await claude.run({
    cwd,
    prompt: buildSpecPlanPrompt(issue),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("spec_plan: cancelled");
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
