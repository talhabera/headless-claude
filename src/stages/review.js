// src/stages/review.js
import { parseResultBlock } from "./parse.js";

export function buildReviewPrompt(spec, checklist) {
  return `You are an independent reviewer. Review the committed diff in this
worktree against the spec and the acceptance checklist. Use superpowers
requesting-code-review rigor. Verify each checklist item is actually met by
the code (not just claimed).

SPEC:
${spec}

ACCEPTANCE CHECKLIST: ${checklist}

Output ONLY this block:
<<<RESULT
{"verdict":"approve|changes-requested",
"checklist":[{"item":"...","met":true|false}],"notes":"<actionable>"}
RESULT>>>`;
}

export async function runReview({ db, run, claude, cwd, timeoutMs }) {
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
  });
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
