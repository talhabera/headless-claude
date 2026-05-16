// src/stages/resolveConflict.js
import { parseResultBlock } from "./parse.js";

export function buildResolvePrompt(files) {
  return `A git rebase onto the base branch is in progress with conflicts in:
${files.join("\n")}

Resolve ONLY these conflicts correctly (preserve the intent of both sides),
\`git add\` them, and continue the rebase (\`git rebase --continue\`) until it
completes. Then ensure the project's tests still pass.

Output ONLY this block:
<<<RESULT
{"resolved":true|false,"summary":"<what you did / why not>"}
RESULT>>>`;
}

export async function runResolveConflict({ claude, cwd, files, timeoutMs }) {
  const res = await claude.run({
    cwd,
    prompt: buildResolvePrompt(files),
    timeoutMs,
  });
  if (res.timedOut) throw new Error("rebase-resolve: timed out");
  if (res.code !== 0)
    throw new Error(`rebase-resolve: claude exited ${res.code}`);
  const parsed = parseResultBlock(res.stdout);
  if (!parsed.resolved)
    throw new Error(`rebase-resolve: ${parsed.summary || "unresolved"}`);
  return { resolved: true, summary: parsed.summary || "" };
}
