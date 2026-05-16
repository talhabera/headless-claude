// src/stages/resolveConflict.js
import { parseResultBlock } from "./parse.js";

export function buildResolvePrompt(files) {
  return `A git rebase onto the base branch is in progress with conflicts in:
${files.join("\n")}

PIPELINE CONSTRAINTS (mandatory):
- You are running inside an automated orchestrator. The orchestrator EXCLUSIVELY owns all git-remote and GitHub operations.
- DO NOT run \`gh\` at all (no \`gh pr create\`, \`gh pr\`, \`gh issue\`, \`gh api\`). DO NOT \`git push\`, create/switch/delete branches, open or modify pull requests or issues, or change git remotes.
- Work ONLY in the current worktree: read/edit files, run the project's tests/lint/typecheck, and \`git add\`/\`git commit\` locally. Nothing else.
- Creating a PR or pushing yourself will produce a duplicate/wrong-base PR and is a hard error.

Resolve ONLY these conflicts correctly (preserve the intent of both sides),
\`git add\` them, and continue the rebase (\`git rebase --continue\`) until it
completes. Then ensure the project's tests still pass.

Output ONLY this block:
<<<RESULT
{"resolved":true|false,"summary":"<what you did / why not>"}
RESULT>>>`;
}

export async function runResolveConflict({ claude, cwd, files, timeoutMs, signal }) {
  const res = await claude.run({
    cwd,
    prompt: buildResolvePrompt(files),
    timeoutMs,
    signal,
  });
  if (res.cancelled) throw new Error("rebase-resolve: cancelled");
  if (res.timedOut) throw new Error("rebase-resolve: timed out");
  if (res.code !== 0)
    throw new Error(`rebase-resolve: claude exited ${res.code}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.resolved)
    throw new Error(`rebase-resolve: ${parsed.summary || "unresolved"}`);
  return { resolved: true, summary: parsed.summary || "" };
}
