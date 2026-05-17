// src/stages/prReview.js
import { parseResultBlock } from "./parse.js";

export function buildPrReviewPrompt(base) {
  return `You are an independent reviewer of an OPEN pull request. Review the
committed diff of \`${base}...HEAD\` in this worktree using superpowers
code-review rigor (correctness, security, tests, conventions, regressions).

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read files and run the project's tests/lint/typecheck to inform the review. Do NOT modify code in this stage.

Judge the committed diff only. The verdict MUST be \`changes-requested\` if
there is ANY correctness bug, security issue, missing/insufficient test for
changed behavior, or violation of a stated project convention (e.g. hardcoded
values where i18n/config keys are required). Otherwise \`approve\`.

Output ONLY this block:
<<<RESULT
{"verdict":"approve|changes-requested",
"findings":["<actionable finding>", "..."],"notes":"<summary>"}
RESULT>>>`;
}

export async function runPrReview({ db, run, claude, cwd, base, timeoutMs, signal }) {
  const res = await claude.run({
    cwd,
    prompt: buildPrReviewPrompt(base),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("pr-review: cancelled");
  if (res.timedOut) throw new Error("pr-review: timed out");
  if (res.code !== 0)
    throw new Error(`pr-review: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  db.prepare(
    `INSERT INTO run_artifacts (run_id,kind,content) VALUES (?,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET content=excluded.content`,
  ).run(run.id, "pr_review_verdict", JSON.stringify(parsed));
  return {
    verdict: parsed.verdict === "approve" ? "approve" : "changes-requested",
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    notes: parsed.notes || "",
  };
}
