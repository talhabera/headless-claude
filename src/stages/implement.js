// src/stages/implement.js
import { parseResultBlock } from "./parse.js";

export function buildImplementPrompt(plan) {
  return `Implement the plan below in this worktree using strict TDD
(superpowers test-driven-development): write failing tests first, minimal
code, refactor. Detect the project's own test/lint/typecheck commands and
run them. Do NOT finish until tests, lint, and typecheck are all green.
Commit frequently.

PLAN:
${plan}

Output ONLY this block at the end:
<<<RESULT
{"allGreen":true|false,"summary":"<what you did / why not green>"}
RESULT>>>`;
}

export async function runImplement({ db, run, claude, cwd, timeoutMs }) {
  const plan =
    db
      .prepare("SELECT content FROM run_artifacts WHERE run_id=? AND kind='plan'")
      .get(run.id)?.content || "";
  const res = await claude.run({
    cwd,
    prompt: buildImplementPrompt(plan),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("implement: timed out");
  if (res.code !== 0)
    throw new Error(`implement: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.allGreen)
    throw new Error(`implement: gate not green: ${parsed.summary || "unknown"}`);
  return { allGreen: true, summary: parsed.summary || "" };
}
