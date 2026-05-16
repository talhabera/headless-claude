// src/preview.js
import { setTimeout as sleep } from "node:timers/promises";

/**
 * mergeToPreview({ git, project, runBranch })
 *
 * Pushes `runBranch` into the project's preview branch ref on origin using
 * only the injected `git` runner — no shell, no direct network calls.
 *
 * Returns a result object — never throws.
 *
 * Steps:
 *  1. fetch origin --prune  (sync the local clone)
 *  2. push origin runBranch:runBranch  (ensure the run branch ref exists on origin)
 *  3. fetch origin preview_branch  (best-effort, result ignored)
 *  4. push origin runBranch:preview_branch  (make the preview env build this commit)
 *
 * On any failure returns { ok: false, step: <string>, reason: <stderr> }.
 * On success returns   { ok: true,  previewBranch: project.preview_branch }.
 */
export async function mergeToPreview({ git, project, runBranch }) {
  const lp = project.local_path;

  // Step 1 — fetch + prune
  const fetch = git(lp, ["fetch", "origin", "--prune"]);
  if (fetch.code !== 0) {
    return { ok: false, step: "fetch", reason: fetch.stderr };
  }

  // Step 2 — push run branch ref to origin
  const pushRun = git(lp, ["push", "origin", `${runBranch}:${runBranch}`]);
  if (pushRun.code !== 0) {
    return { ok: false, step: "push-run", reason: pushRun.stderr };
  }

  // Step 3 — best-effort fetch of preview branch (ignore result)
  git(lp, ["fetch", "origin", project.preview_branch]);

  // Step 4 — push run branch onto preview branch ref
  const pushPreview = git(lp, [
    "push",
    "origin",
    `${runBranch}:${project.preview_branch}`,
  ]);
  if (pushPreview.code !== 0) {
    return {
      ok: false,
      step: "update-preview",
      reason: pushPreview.stderr,
    };
  }

  return { ok: true, previewBranch: project.preview_branch };
}

/**
 * pollUrl(url, { timeoutMs, pollMs, fetchImpl })
 *
 * Polls `GET url` every `pollMs` milliseconds until:
 *   - A response with status >= 200 && status < 400 arrives → resolves
 *     { ok: true, status, elapsedMs }
 *   - `timeoutMs` has elapsed → resolves
 *     { ok: false, reason: "preview deploy not live within <timeoutMs>ms",
 *       lastStatus? | lastError? }
 *
 * Always resolves — never rejects. Thrown fetch errors are treated as failed
 * attempts and polling continues. Non-blocking: waits between polls via
 * node:timers/promises setTimeout so the event loop is not blocked.
 *
 * `fetchImpl` defaults to the global `fetch` so it is injectable for tests.
 */
export async function pollUrl(
  url,
  { timeoutMs, pollMs, fetchImpl = globalThis.fetch }
) {
  const start = Date.now();
  let lastStatus;
  let lastError;

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      const base = { ok: false, reason: `preview deploy not live within ${timeoutMs}ms` };
      if (lastError !== undefined) base.lastError = lastError;
      else if (lastStatus !== undefined) base.lastStatus = lastStatus;
      return base;
    }

    try {
      const res = await fetchImpl(url);
      if (res.status >= 200 && res.status < 400) {
        return { ok: true, status: res.status, elapsedMs: Date.now() - start };
      }
      lastStatus = res.status;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    // Wait before next attempt, but bail early if timeout would pass
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      const base = { ok: false, reason: `preview deploy not live within ${timeoutMs}ms` };
      if (lastError !== undefined) base.lastError = lastError;
      else if (lastStatus !== undefined) base.lastStatus = lastStatus;
      return base;
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
