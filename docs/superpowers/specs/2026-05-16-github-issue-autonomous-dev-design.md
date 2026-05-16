# GitHub-Issue-Driven Autonomous Development — Design

Date: 2026-05-16
Status: Approved (pending spec review)

## Goal

Label a GitHub issue → `headless-claude` autonomously develops it on an
isolated git worktree, enforcing a strict correctness bar, until a PR is
opened against a version branch. The human reviews the PR and merges. Large
issues are decomposed into dependency-ordered sub-issues that each flow
through the same pipeline. Open PRs are kept rebased on a moving base.

This is a **new subsystem alongside** the existing tmux pool
(`pool.js`/`server.js`). The pool's interactive-session behavior is **not
modified**; we extend the Express app, add a SQLite store, and add a headless
orchestrator.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Correctness bar | All four, enforced as gates: (1) spec+plan first with passing self-review, (2) TDD — tests+lint+typecheck green, (3) separate agent code review must approve, (4) acceptance-criteria checklist verified & rendered in PR body |
| Project model | Clone-on-register: register repo → clone once into `PROJECTS_DIR/<slug>` |
| Storage | SQLite via `better-sqlite3` |
| Trigger | Polling the `gh` API on an interval (no public ingress) |
| Execution | Headless `claude -p` process per stage, in the run's worktree, permissions bypassed (safe: isolated worktree + dedicated branch + PR-only, no direct push to base) |
| Run state | SQLite is source of truth; GitHub label mirrors state; failures also comment on the issue |
| Concurrency | Global concurrency cap, FIFO queue, manual retry on failure |
| Oversized issues | Decision gate: spec+plan judges size; small → single run; large → emit independent GitHub sub-issues, parent ends `decomposed` |
| Sub-issue deps | Dependency DAG + `blocked` run state; dependent runs wait until prerequisite issues are merged/closed; independent base-branch PRs (no stacking); cycle check |
| Parallelism | Global semaphore for run count; per-project git mutex around fetch/worktree plumbing; shared clone never dirtied (all work in per-run worktrees) |
| Base movement | Auto-rebase in-flight runs at stage boundaries; PR-maintenance sweep rebases system-owned open PRs that are behind |
| Rebase conflict | Bounded model-driven resolution stage, then re-run review+test gate; safety net → `failed` if still unresolved |

## Architecture

```
┌─────────────── headless-claude process ───────────────┐
│ gh API ◀──▶ Poller(interval) ──enqueue──▶ Run Queue (SQLite)
│                                              │
│                                         Scheduler
│                              (global MAX_CONCURRENT_RUNS semaphore, FIFO)
│                                              │
│                                        Run Executor
│              spec_plan ─▶ implementing ─▶ reviewing ─▶ pr_open ─▶ merged
│                    │  (decision gate)        ▲   sync checkpoints rebase
│                    └─▶ decomposing ─▶ decomposed
│                                              │
│  PR-sweep(interval) ── rebase system-owned open PRs behind base
│                                              │
│  Workspace Mgr: git worktree per run (per-project git mutex)
│  SQLite: projects, runs, run_logs, run_artifacts, issue_deps
│  HTTP API + `cdev` CLI + dashboard (public/)
└────────────────────────────────────────────────────────┘
```

### Components (single responsibility each)

- **Project registry** — register/list/remove. On register: derive `slug`,
  `git clone` into `PROJECTS_DIR/<slug>`, persist
  `{repo, slug, local_path, watch_label, base_branch}`.
- **Poller** (`ISSUE_POLL_MS`) — per project, list open issues with
  `watch_label` via `gh`. New issue with no active run → insert `run`
  (`blocked` if it has unmet `issue_deps`, else `queued`), claim by swapping
  label → `in-progress`. Detect blocker issue closed → flip dependents
  `blocked → queued`. Detect tracked issue closed/PR merged → run `merged`.
- **Scheduler** — global semaphore `MAX_CONCURRENT_RUNS`; picks `queued`
  runs FIFO (skips `blocked`); hands to Executor.
- **Run Executor** — drives the per-run state machine; writes `runs.state`
  + `run_logs` per step; persists stage outputs to `run_artifacts`.
- **Workspace Manager** — per-run `git worktree` off `base_branch`; per-
  project async mutex around `fetch`/base ff/`worktree add|remove`/rebase;
  teardown per terminal state; startup orphan + stale-lock sweep.
- **PR-maintenance sweep** (`PR_SYNC_MS`) — keep system-owned open PRs
  rebased on base.
- **Control surface** — HTTP API (existing Express + token auth), `cdev`
  CLI, dashboard Runs view.

### External-tool adapters

`gh` and `claude -p` are each wrapped behind one thin adapter module so all
units are testable with them stubbed (no network, no model calls).

## Data model (SQLite)

```sql
projects(
  id INTEGER PK, slug TEXT UNIQUE, repo TEXT, local_path TEXT,
  watch_label TEXT, base_branch TEXT, created_at TEXT)

runs(
  id INTEGER PK, project_id INTEGER FK, issue_number INTEGER,
  parent_run_id INTEGER NULL, state TEXT,
  worktree_path TEXT NULL, branch TEXT NULL, pr_url TEXT NULL,
  attempt INTEGER DEFAULT 1, fail_reason TEXT NULL,
  last_synced_base_sha TEXT NULL,
  needs_attention INTEGER DEFAULT 0, attention_reason TEXT NULL,
  created_at TEXT, updated_at TEXT,
  UNIQUE(project_id, issue_number, attempt))

run_logs(
  id INTEGER PK, run_id INTEGER FK, stage TEXT, level TEXT,
  message TEXT, ts TEXT)

run_artifacts(
  run_id INTEGER FK, kind TEXT, content TEXT,
  PRIMARY KEY(run_id, kind))   -- kind: spec|plan|review_verdict|acceptance_checklist

issue_deps(
  project_id INTEGER, issue_number INTEGER,
  depends_on_issue_number INTEGER,
  PRIMARY KEY(project_id, issue_number, depends_on_issue_number))
```

`runs` is source of truth. `UNIQUE(project_id,issue_number,attempt)` + the
label-claim on pickup prevents double-enqueue.

## State machine

```
queued
  └▶ spec_plan       claude -p: brainstorm→spec→writing-plans; self-review must
       │               pass. Emits acceptance checklist from issue criteria.
       │               Judges size + (if large) a dependency DAG.
       ├─(small)─▶ implementing
       └─(large)─▶ decomposing ─▶ create sub-issues + issue_deps (DAG, cycle-
       │                          checked; cyclic → fail parent w/ reason)
       │                       ─▶ decomposed                       (terminal)
  blocked            sub-issue with unmet issue_deps; → queued when all
                      prerequisite issues closed/merged
  implementing       [sync checkpoint] claude -p: TDD per plan in worktree;
       │               must end tests + lint + typecheck green (project-detected)
       ▼
  reviewing          [sync checkpoint] claude -p reviewer: diff vs spec +
       │               acceptance checklist. approve → pr; changes-requested
       │               → implementing (one loop); 2nd failure → failed
       ▼
  pr_open            gh pr create → base_branch; body = acceptance checklist +
       │               spec link + "Closes #<issue>". Under PR-maintenance.
       ▼
  merged             you merge PR → poller sees issue closed → cleanup branch +
                      worktree; unblock dependents                 (terminal)

  failed             any stage hard-errors / gate fails terminally / rebase
                      unresolved. label→failed + issue comment      (terminal)
```

Label mapping: `in-progress` (queued, blocked, spec_plan, implementing,
reviewing, decomposing), `pr-open` (pr_open), `decomposed`, `merged`,
`failed`. Each transition writes `runs.state` + a `run_logs` row.

### Sync checkpoint (auto-rebase, in-flight)

At each marked boundary, under the per-project git mutex: if
`origin/<base>` advanced past `runs.last_synced_base_sha`,
`git rebase origin/<base>` in the worktree; update
`last_synced_base_sha`; continue. Never mid-stage (would corrupt an
active `claude -p` write).

### PR-maintenance sweep

`PR_SYNC_MS` interval. For each system-owned open PR (`branch` prefix
`claude/`, tracked via `runs.pr_url`): `gh pr view --json
mergeable,mergeStateStatus`. Behind & clean → rebase branch + `git push
--force-with-lease` (own branch only; PR refreshes). Conflict → rebase-
resolve path.

### Rebase-resolve path (conflict)

Bounded `claude -p` `resolve-conflict` stage scoped to conflicted hunks
→ complete rebase → re-run review + test gate. One attempt,
`STAGE_TIMEOUT_MS`. Still unresolved or gate fails → `failed`,
`fail_reason="rebase-resolve: …"`, issue/PR comment.

## Workspace lifecycle

- Pre-run: under per-project mutex, `git fetch origin` + fast-forward
  `base_branch` in the clone (clone working tree never checked out/dirtied).
- `git worktree add WORKTREES_DIR/<slug>-<issue>-<attempt> -b
  claude/<issue>-<slug>` off base. Worktree is `cwd` for all stages of the
  run.
- Teardown: `merged`/`decomposed` → remove worktree (+ branch on merged);
  `pr_open` → remove worktree, keep pushed branch; `failed` → keep worktree
  if `KEEP_FAILED_WORKTREE` else remove.
- Startup sweep: prune worktrees with no non-terminal run; clear stale git
  lock files; reconcile labels to DB.

## Parallelism model

1. **Run count** — global `MAX_CONCURRENT_RUNS` semaphore (FIFO; no per-
   project quota).
2. **Same-project safety** — per-run worktree + branch; shared clone never
   dirtied; per-project async mutex serializes only fetch/ff/worktree/rebase
   plumbing (correctness lock, orthogonal to the semaphore).
3. **Sub-issues** — the dependency DAG *is* the parallelism plan: independent
   sub-issues parallelize up to the cap; dependents sit `blocked`.

Deliberate non-goal: in-flight runs are not continuously rebased onto every
base change — only at sync checkpoints and via the PR sweep. Cross-PR
conflicts not expressed as `issue_deps` surface at human merge time as normal
git conflicts.

## Control surface

| Endpoint | Purpose |
|---|---|
| `POST /projects {repo,watch_label,base_branch}` | register + clone |
| `GET /projects` / `DELETE /projects/:slug` | list / remove |
| `GET /runs?state=&project=` | run list |
| `GET /runs/:id` | detail: state, logs, artifacts |
| `POST /runs/:id/retry` | new attempt without re-labeling |
| `POST /runs/:id/cancel` | kill `claude -p`, → failed |
| `POST /poll` | manual poll tick |
| `public/` dashboard | Runs view: state, stage, issue/PR links, log tail |

`cdev` CLI (mirrors `cspawn` style): `cdev add <repo> --label L --base B`,
`cdev runs`, `cdev logs <id>`, `cdev retry <id>`.

## Error handling & recovery

- Each `claude -p` stage: wall-clock `STAGE_TIMEOUT_MS`, captured
  stdout/stderr → `run_logs`. Non-zero exit / timeout / unmet gate → `failed`
  with `fail_reason="<stage>: <reason>"` + issue comment.
- Crash recovery: on startup, non-terminal runs with a live worktree but no
  process re-queue from the last completed stage (artifacts let finished
  stages be skipped); labels re-asserted to DB.
- `gh`/network ops retry with backoff. PR-create failure after green
  implement → `failed` (state preserved), retryable.

## Testing

TDD per the correctness bar. Pure units (state transitions, dep-DAG cycle
detection, slug/branch derivation, label↔state mapping, semaphore/mutex
behavior) on the project's Node test runner. `gh` and `claude -p` stubbed via
their adapter modules. One integration test drives a fake project
`queued → pr_open` with both adapters mocked, plus a decomposition case
(parent → sub-issues + `issue_deps`) and a rebase-conflict case.

## Config (env)

`PROJECTS_DIR`, `WORKTREES_DIR`, `ISSUE_POLL_MS`, `PR_SYNC_MS`,
`MAX_CONCURRENT_RUNS`, `STAGE_TIMEOUT_MS`, `KEEP_FAILED_WORKTREE`,
`DB_PATH`. Reuses existing `AUTH_TOKEN`, `HOST`, `PORT`.

## Out of scope (YAGNI)

GitHub webhooks; per-project concurrency quotas; PR branch stacking;
continuous rebase of in-flight runs; auto-merge (human merges).
