# Autonomous-dev — tracked follow-ups (post final review)

All 28 plan tasks implemented; 67/67 tests green; final whole-implementation
review verdict: spec-faithful, no data-loss/happy-path defects. Items below
are spec aspirations the plan under-specified — captured here, not fixed in
this branch.

## Resolved in this branch
- **projects.remove orphaning** (review Important #2) — FIXED (commit
  `2883554`): `remove()` now deletes child rows (runs/run_logs/run_artifacts/
  issue_deps) and the clone dir, idempotently.

- **`POST /runs/:id/cancel` did not kill the running `claude -p`**
  (spec line 213; review Important #1) — FIXED (commits `3f7c92f`,
  `2d02d31`): AbortController per run in the executor, `signal` threaded
  through the claude adapter + stages (SIGKILL child on abort),
  `executor.cancel(runId)` wired via `wire.js`→`api.js`. Between-stages /
  hung-await cancels handled via `ensureNotCancelled` checkpoints +
  `raceAbort`; deterministic `fail_reason="cancelled by user"`; API
  surfaces `{ok,cancelled,killed}`. Spec + code-quality reviewed.

- **decompose → poller TOCTOU on `issue_deps`** (review Important #3) —
  FIXED (commit `5093b2e`): `decompose` now runs in strict phases —
  create all sub-issues, insert all `issue_deps` in a single
  `db.transaction`, THEN apply the watch label, then the rollup comment.
  No window where a labeled sub-issue lacks its deps. Ordering-invariant
  test added.

- **Startup orphan-worktree prune + stale git-lock sweep**
  (spec lines 74, 187) — FIXED (commits `b098ac5`, `3ae66c3`):
  `src/sweep.js` `sweepWorkspacesOnStartup` runs in `wire.js` after
  `reconcileOnStartup` + `createGit`. Prunes registered/leftover worktrees
  under `worktreesDir` with no live (`pr_open`) run and clears stale
  `.git/*.lock`. Hardened after a safety review: realpath-normalized
  comparisons (symlink-safe), absolute/non-empty `worktreesDir` guard,
  boundary-aware containment, never targets the clone or a live worktree,
  NUL-delimited porcelain, `lstat` (no symlink follow), removal gated on
  `git worktree remove` success. 8 sweep tests incl. 4 adversarial
  data-loss cases.

## Open follow-ups
- (Aspiration) crash recovery resumes from `queued`, not last completed
  stage (spec line 227). **Recommendation: keep as-is — do not implement.**
  It is deliberate and safe (per-attempt worktree path is idempotent; a
  clean re-run from `queued` is correct). Resume-from-stage would add
  artifact-driven stage-skipping branches across the executor state
  machine — real complexity and risk for a re-run that, in practice,
  costs one extra spec+plan/implement pass only after a mid-run crash.
  Not a defect; tracked only so the choice stays visible.
