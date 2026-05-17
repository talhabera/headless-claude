# cdev PR Review Watcher — Design

**Date:** 2026-05-17
**Status:** Approved (design), pending implementation plan
**Scope:** Extend the headless-claude autonomous subsystem with a first-class
PR review/fix loop for cdev's own pull requests.

## Problem

The cdev autonomous subsystem develops labeled GitHub issues into PRs, but once
a PR is open it does nothing further with it: it does not review the PR, does
not act on the user's review comments, and has no feedback loop. The user must
manually drive every revision (as happened with PR #36, where a Turkish-spelling
comment had to be patched by hand). We want a persistent, always-on watcher
that reviews each cdev PR with superpowers code-review rigor, implements fixes,
acts on the user's comments, and waits — never merging. The user merges.

## Goals

- For every cdev-authored PR (a run in `state='pr_open'`), run an independent
  code review using superpowers code-review rigor.
- Auto-implement review findings, commit, and push, re-reviewing until the
  verdict is `approve` (capped — see Safety).
- When the user comments on the PR, implement the requested change, push, and
  reply.
- Never merge. The user merges. Existing poller/reconcile already detects the
  merged/closed PR and cleans up the worktree/branch.
- Idempotent: no token burn while waiting with nothing new to do.

## Non-Goals (YAGNI)

- Human-authored / non-cdev PRs.
- Any merge capability (structurally absent).
- Multi-repo beyond what cdev already registers.
- A dashboard panel for the review loop.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Mechanism | First-class feature in the headless-claude subsystem |
| PR scope | Only cdev's own PRs (runs in `state='pr_open'`) |
| Review cycle | Re-review → fix → push until verdict `approve`, then wait for user comments |
| Loop safety cap | 4 review→fix iterations, then post remaining findings + `needs_attention` + wait |
| Merge | Never — user merges |

## Architecture

New module `src/prReview.js` exposing
`createPrReview({ db, gh, workspace, stages, claude, config })` with a single
`tick()`, sibling to the existing `src/prSweep.js`. Constructed in `wire.js`,
returned from `buildAutonomous`, and driven by a dedicated `setInterval` in
`server.js` scheduled **after** `prSweep` so reviews evaluate a rebased tree.

Separation of concerns: `prSweep` keeps the branch mergeable (rebase on base);
`prReview` runs the review/fix/comment loop. Each is independently idempotent
and testable. Both guard the run's `worktree_path` via the existing keyed
mutex so they never race each other or a lingering executor.

### tick() algorithm

For each project, for each run with `state='pr_open'`:

1. `gh.prStatus(repo, branch)`. If `state !== 'OPEN'` → skip (poller/reconcile
   own merge/close cleanup; the bot never merges). If no `worktree_path` →
   skip (manual).
2. Compute the **diff fingerprint** = `git patch-id` of `base...HEAD` in the
   worktree (stable across a pure rebase — `prSweep` rebasing the branch does
   NOT change it, so it never spuriously re-triggers a review) and read PR
   comments (`gh.prComments`). "Work exists" iff:
   - there is a user comment with `createdAt` strictly greater than
     `pr_last_comment_at` whose author ≠ resolved bot login, **or**
   - `pr_reviewed_diff_id` ≠ current diff fingerprint.
   If no work and `pr_phase='waiting_user'` → no-op (idempotent; zero tokens).
3. **New user comment present** → run `runPrFix` with the concatenated new
   comment bodies as the change request → `git commit` (stage, local only) →
   `workspace.pushBranch` → `gh.prComment` reply summarising → set
   `pr_last_comment_at` to the newest processed comment createdAt, `pr_review_iterations=0`,
   `pr_reviewed_diff_id=NULL`, `pr_phase='reviewing'`. If
   `needs_attention=1` AND `attention_reason` is the review-cap marker, clear
   it (a rebase-conflict `needs_attention` is left untouched). Return.
4. Otherwise (new commits / first open; `pr_phase='reviewing'`) → run
   `runPrReview` over the committed `base..HEAD` diff:
   - `approve` → `pr_phase='waiting_user'`, `pr_reviewed_diff_id=fingerprint`; post
     a single "✅ automated review passed — waiting for your comments" PR
     comment (once per head). Done.
   - `changes-requested` and `pr_review_iterations >= config.prReviewMaxIterations`
     → `gh.prComment` with the remaining findings, set `needs_attention=1`
     with the review-cap marker `attention_reason`, `pr_phase='waiting_user'`.
   - `changes-requested` and under cap → run `runPrFix` with the findings →
     commit → push → `pr_review_iterations += 1`. Next tick re-reviews the new
     head (since `pr_reviewed_diff_id` ≠ new fingerprint).

All `claude` stage invocations are bounded by `config.stageTimeoutMs` via the
existing claude adapter, run in the run's worktree.

## Schema changes

Added to `runs` via the existing idempotent `ALTER TABLE` migration block in
`src/db.js` (same precedent as the `preview_branch`/`preview_url` columns — no
destructive migration; older rows get NULL/default and behave as a fresh
`reviewing` run on first encounter):

| Column | Type | Purpose |
|---|---|---|
| `pr_phase` | TEXT | `reviewing` \| `waiting_user`; gates the loop. NULL ⇒ treated as `reviewing`. |
| `pr_reviewed_diff_id` | TEXT | git patch-id of `base...HEAD` the last review evaluated; rebase-stable; mismatch ⇒ new commits ⇒ re-review. |
| `pr_review_iterations` | INTEGER DEFAULT 0 | auto review→fix passes; compared to cap. Reset on new user comment. |
| `pr_last_comment_at` | TEXT | newest processed comment `createdAt` (ISO, lexicographically sortable); only strictly-newer non-bot comments trigger work. |

## Stages & adapter additions

- **`src/stages/prReview.js` — `runPrReview`**: prompt instructs an independent
  review of the committed `base..HEAD` diff using superpowers code-review
  rigor. Same `<<<RESULT` block + `parseResultBlock` contract and the same
  hard PIPELINE CONSTRAINTS as `src/stages/review.js` (no `gh`, no push,
  no branch/PR ops, worktree-only). Verdict persisted to `run_artifacts`
  (`kind='pr_review_verdict'`).
- **`src/stages/prFix.js` — `runPrFix({ changeRequest })`**: reuses the
  `runImplement` baseline-protocol + strict-TDD prompt, but the driving input
  is the review findings *or* the user's comment text rather than a stored
  plan. Local commit only; orchestrator owns push. Same PIPELINE CONSTRAINTS.
- **gh adapter (`src/adapters/gh.js`)**, mirroring existing method style:
  - `prComments(repo, head)` → `gh pr view <head> -R <repo> --json comments`,
    returns the comments array (`{id, author:{login}, body, createdAt}`).
  - `prComment(repo, prNumber, body)` → `gh pr comment <prNumber> -R <repo>
    --body <body>`.
  - `viewer()` → `gh api user -q .login`, returns the authenticated login.
  - No merge method is added anywhere — the bot structurally cannot merge.

(The reviewed-diff fingerprint is computed locally via `git patch-id` in the
worktree, not through the gh adapter — no PR-head-SHA adapter method needed.)

Bot-authored comments are excluded by a bot login resolved as:
`config.botLogin` (env `PR_BOT_LOGIN`) if set, else lazily via `gh.viewer()`
memoized inside `prReview` on first tick (kept out of `buildAutonomous`
construction so the composition root stays offline-constructable for tests).
That login is filtered out of the "new user comment" scan.

## Config

`src/config.js` additions:

| Key | Env | Default |
|---|---|---|
| `prReviewMs` | `PR_REVIEW_MS` | `120000` |
| `prReviewMaxIterations` | `PR_REVIEW_MAX_ITERATIONS` | `4` |
| `botLogin` | `PR_BOT_LOGIN` | `""` (empty ⇒ lazy `gh.viewer()` in prReview) |

Reuses `stageTimeoutMs`.

## Wiring & operations

- `prReview` constructed in `wire.js`, returned from `buildAutonomous`.
- New `setInterval(... prReview.tick() ..., config.prReviewMs)` in
  `server.js`, scheduled after the `prSweep` interval.
- Extend the `autonomous-dev wired:` startup log with `prReview=<ms>`.
- The systemd service does not hot-reload: after merge,
  `systemctl --user restart headless-claude.service` and confirm the new
  `autonomous-dev wired:` line includes `prReview=`.

## Safety / failure modes

- **Oscillation cap:** after `prReviewMaxIterations` (4) review→fix passes
  without `approve`, stop, post remaining findings, set `needs_attention=1`
  with a review-cap marker, and wait for the user. A subsequent user comment
  clears the review-cap `needs_attention` and resumes.
- **Rebase-conflict `needs_attention`** (set by `prSweep`) is never
  auto-cleared by `prReview`; it is a distinct concern surfaced to the user.
- **Idempotency:** `pr_phase='waiting_user'` + no new comment + unchanged head
  ⇒ pure no-op; the loop never burns tokens while genuinely waiting.
- **Concurrency:** worktree mutex prevents `prReview`/`prSweep`/executor from
  stomping the same worktree.
- **No merge path:** absence of any merge adapter method makes
  bot-initiated merge structurally impossible.

## Test plan

Unit tests with injected fakes (follow `test/prSweep.test.js` patterns):

- First open → `runPrReview` invoked.
- `changes-requested` under cap → `runPrFix` + push + `pr_review_iterations++`.
- `approve` → `pr_phase='waiting_user'` + exactly one summary comment.
- Cap reached → `needs_attention=1` + findings comment + no further fix.
- New user comment → `runPrFix` + reply + counter reset + re-enter reviewing.
- `waiting_user` & nothing new → no-op (no stage calls).
- PR not `OPEN` → skip.
- Bot's own comment ignored (author == `botLogin`).
- Review-cap `needs_attention` cleared by a new user comment; rebase-conflict
  `needs_attention` left intact.
- `db.js` migration adds the 4 columns idempotently (re-open is a no-op).
- Wiring test: `prReview` constructed by `buildAutonomous`; server interval
  present; startup log includes `prReview=`.
