// src/stages/review.js
import { parseResultBlock } from "./parse.js";

export function buildReviewPrompt(spec, checklist) {
  return `You are an independent reviewer. Review the committed diff in this
worktree against the spec and the acceptance checklist. Use superpowers
requesting-code-review rigor.

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr create\`, \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run the project's tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Creating a PR or pushing yourself will produce a duplicate/wrong-base PR and is a hard error.

Verify EACH acceptance checklist item item by item against the committed diff —
do not assume an item is met; check the actual code. Additionally, verify that
every explicit convention stated in the spec is followed: call out hardcoded
values where the spec/issue mandates i18n/config keys, wrong file locations,
and behavior changes when "no behavior change" was required.

The verdict MUST be \`changes-requested\` if ANY acceptance item is unmet OR
ANY stated convention is violated. Approving a partially-correct or
convention-violating change is itself a review failure.

SPEC:
${spec}

ACCEPTANCE CHECKLIST: ${checklist}

Output ONLY this block:
<<<RESULT
{"verdict":"approve|changes-requested",
"checklist":[{"item":"...","met":true|false}],"notes":"<actionable>"}
RESULT>>>`;
}

export async function runReview({ db, run, claude, cwd, timeoutMs, signal }) {
  const spec =
    db.prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='spec'").get(run.id)
      ?.content || "";
  const checklist =
    db
      .prepare(
        "SELECT content FROM run_artifacts WHERE run_id=? AND kind='acceptance_checklist'",
      )
      .get(run.id)?.content || "[]";
  const res = await claude.run({
    cwd,
    prompt: buildReviewPrompt(spec, checklist),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("review: cancelled");
  if (res.timedOut) throw new Error("review: timed out");
  if (res.code !== 0)
    throw new Error(`review: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  db.prepare(
    `INSERT INTO run_artifacts (run_id,kind,content) VALUES (?,?,?)
     ON CONFLICT(run_id,kind) DO UPDATE SET content=excluded.content`,
  ).run(run.id, "review_verdict", JSON.stringify(parsed));
  return {
    verdict: parsed.verdict === "approve" ? "approve" : "changes-requested",
    notes: parsed.notes || "",
    checklist: parsed.checklist || [],
  };
}
