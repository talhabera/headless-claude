// src/stages/prFix.js
import { parseResultBlock } from "./parse.js";

export function buildPrFixPrompt(changeRequest) {
  return `Apply the requested change to the OPEN pull request in this worktree
using strict TDD (superpowers test-driven-development): failing test first,
minimal code, refactor. Detect and run the project's own
test/lint/typecheck/build commands.

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Pushing or creating a PR yourself is a hard error.

BASELINE PROTOCOL (mandatory — gate is baseline-relative, NOT whole-repo-green):
1. Before changing code, run the project's test/lint/typecheck/build on the UNMODIFIED tree and record pre-existing failures.
2. Implement ONLY the requested change with strict TDD. NEVER fix unrelated pre-existing failures.
3. Re-run the same commands; use \`git stash\` to compare before/after if needed.
4. The bar to pass: (a) tests covering your change PASS; (b) ZERO new test/lint/typecheck/build failures vs baseline.
5. Commit locally only.

CHANGE REQUEST:
${changeRequest}

Output ONLY this block at the end:
<<<RESULT
{"noNewFailures":true|false,"changeTestsPass":true|false,"summary":"<what you did / why blocked>"}
RESULT>>>`;
}

export async function runPrFix({ claude, cwd, changeRequest, timeoutMs, signal }) {
  const res = await claude.run({
    cwd,
    prompt: buildPrFixPrompt(changeRequest),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("pr-fix: cancelled");
  if (res.timedOut) throw new Error("pr-fix: timed out");
  if (res.code !== 0)
    throw new Error(`pr-fix: claude exited ${res.code}: ${res.stderr.trim()}`);
  const parsed = parseResultBlock(res.stdout);
  const ok = parsed.noNewFailures === true && parsed.changeTestsPass === true;
  return { ok, summary: parsed.summary || "" };
}
