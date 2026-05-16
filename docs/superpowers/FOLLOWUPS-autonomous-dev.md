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

## Open follow-ups
2. **decompose → poller TOCTOU on `issue_deps`** (review Important #3).
   `decompose` labels each sub-issue before all `issue_deps` rows are
   inserted; a poll tick in that window could enqueue a dependent as
   `queued` instead of `blocked`. Fix: create all sub-issues, insert all
   deps, THEN label.
3. **Startup orphan-worktree prune + stale git-lock sweep**
   (spec lines 74, 187). `reconcileOnStartup` only re-queues stranded DB
   rows; it does not prune disk worktrees with no live run or clear stale
   `.git/*.lock`. Hygiene, not correctness.
4. (Aspiration) crash recovery resumes from `queued`, not last completed
   stage (spec line 227) — deliberate, documented, safe (idempotent
   per-attempt worktree path). Optional optimization only.
