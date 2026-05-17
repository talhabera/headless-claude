// src/stages/implement.js
import { parseResultBlock } from "./parse.js";

export function buildImplementPrompt(plan) {
  return `Implement the plan below in this worktree using strict TDD
(superpowers test-driven-development): write failing tests first, minimal
code, refactor. Detect the project's own test/lint/typecheck commands and
run them. Commit frequently.

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr create\`, \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run the project's tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Creating a PR or pushing yourself will produce a duplicate/wrong-base PR and is a hard error.

BASELINE PROTOCOL (mandatory — gate is baseline-relative, NOT whole-repo-green):
1. Before changing any code, establish a baseline: detect and run the project's test, lint, typecheck, and build commands on the UNMODIFIED tree. Record which checks already fail and the failure counts.
2. Implement the change with strict TDD (failing test first), staying strictly scoped to the issue/plan. NEVER "fix" unrelated pre-existing failures to chase whole-repo green — that is out of scope and forbidden.
3. Re-run the same commands after your change. To determine causality honestly, use \`git stash\` (or equivalent) to compare before/after if needed.
4. Determine whether your change introduces ANY NEW failure vs the recorded baseline.
5. The bar to pass:
   (a) The tests you added / that cover your change PASS.
   (b) Your change introduces ZERO new test/lint/typecheck/build failures vs the baseline.
   Pre-existing, unrelated baseline failures that exist WITH AND WITHOUT your change do NOT block and must be reported as baseline — not as your failure.
6. Commit locally only (per the PIPELINE CONSTRAINTS above).

PLAN:
${plan}

Output ONLY this block at the end:
<<<RESULT
{"noNewFailures":true|false,"changeTestsPass":true|false,"baseline":"<pre-existing failures verified present without your change, or 'clean'>","summary":"<what you did / why blocked>"}
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
  // Pass condition: new baseline-relative gate OR legacy allGreen back-compat.
  const passesNewGate =
    parsed.noNewFailures === true && parsed.changeTestsPass === true;
  const passesLegacyGate = parsed.allGreen === true;
  if (!passesNewGate && !passesLegacyGate) {
    throw new Error(
      "implement: gate not green: " +
        (parsed.summary || parsed.baseline || "unknown"),
    );
  }
  return { allGreen: true, summary: parsed.summary || "" };
}
