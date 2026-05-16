# Autonomous-dev — tracked follow-ups (post final review)

All 28 plan tasks implemented; 67/67 tests green; final whole-implementation
review verdict: spec-faithful, no data-loss/happy-path defects. Items below
are spec aspirations the plan under-specified — captured here, not fixed in
this branch.

## Resolved in this branch
- **projects.remove orphaning** (review Important #2) — FIXED (commit
  `2883554`): `remove()` now deletes child rows (runs/run_logs/run_artifacts/
  issue_deps) and the clone dir, idempotently.

## Open follow-ups
1. **`POST /runs/:id/cancel` does not kill the running `claude -p`**
   (spec line 213; review Important #1). Today it only flips
   `runs.state='failed'`; the spawned child runs until `STAGE_TIMEOUT_MS`.
   Fix: thread an `AbortSignal` from an executor-held `Map<runId,
   AbortController>` through the stage runners into the `claude` adapter
   (SIGKILL child on abort); add `executor.cancel(runId)`; have `wire.js`
   pass it to `mountApi`; guard executor post-stage transitions with a
   cancelled check. Cross-cutting (claude.js + 5 stages + executor + api +
   wire) — its own task.
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
