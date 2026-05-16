// src/stages/implement.js
import { parseResultBlock } from "./parse.js";

export function buildImplementPrompt(plan) {
  return `Implement the plan below in this worktree using strict TDD
(superpowers test-driven-development): write failing tests first, minimal
code, refactor. Detect the project's own test/lint/typecheck commands and
run them. Do NOT finish until tests, lint, and typecheck are all green.
Commit frequently.

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr create\`, \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run the project's tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Creating a PR or pushing yourself will produce a duplicate/wrong-base PR and is a hard error.

PLAN:
${plan}

Output ONLY this block at the end:
<<<RESULT
{"allGreen":true|false,"summary":"<what you did / why not green>"}
RESULT>>>`;
}

export async function runImplement({ db, run, claude, cwd, timeoutMs, signal }) {
  const plan =
    db
      .prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='plan'")
      .get(run.id)?.content || "";
  const res = await claude.run({
    cwd,
    prompt: buildImplementPrompt(plan),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("implement: cancelled");
  if (res.timedOut) throw new Error("implement: timed out");
  if (res.code !== 0)
    throw new Error(`implement: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.allGreen)
    throw new Error(`implement: gate not green: ${parsed.summary || "unknown"}`);
  return { allGreen: true, summary: parsed.summary || "" };
}
