# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Run tests: `npm test` (Node's built-in runner, `node --test`; ESM).
- Single test file: `node --test test/executor.test.js`. Single case: `node --test --test-name-pattern "queued → pr_open"`.
- Run the service: `npm start` (`node server.js`), binds `HOST:PORT` from `.env` (default `127.0.0.1:3000`).
- As a daemon: user systemd unit `headless-claude.service` (`systemctl --user restart|status headless-claude.service`, `journalctl --user -u headless-claude.service -f`). It does NOT hot-reload — restart to pick up code changes. `KillMode=process` so a restart does not kill pooled tmux sessions.
- No build step, no linter. Node 20, ESM (`"type": "module"`), only runtime deps: `express`, `better-sqlite3`.

## Two independent subsystems, one process

`server.js` runs **both** behind one Express app + one bearer-token middleware (token from `.env` `AUTH_TOKEN`, auto-generated on loopback if unset; `/` and `/healthz` are unauthenticated):

1. **tmux pool** (`pool.js`) — keeps warm `claude` CLI tmux sessions per cwd; reconciled by a watchdog interval. Endpoints `/status /spawn /kill/:id /reconcile`. Driven by the `cspawn` CLI. This subsystem predates the autonomous one and is independent — do not entangle them.
2. **autonomous GitHub-issue dev** (`src/`, wired by `src/wire.js`) — watches registered repos for a label and develops issues to a PR. Endpoints `/projects /runs /poll` etc.; driven by the `cdev` CLI. Two intervals: poll+schedule (`ISSUE_POLL_MS`) and PR-maintenance sweep (`PR_SYNC_MS`).

`buildAutonomous({env})` in `src/wire.js` is the composition root: it loads config, opens the DB, runs `reconcileOnStartup` then `sweepWorkspacesOnStartup`, constructs every component via DI, and returns `{..., mount}`. `server.js` calls `autonomous.mount(app)` and starts the two intervals before `app.listen`.

## Autonomous pipeline architecture

SQLite (`better-sqlite3`, `src/db.js`) is the **source of truth**; GitHub labels only mirror state. Flow:

`poller` (claims labeled issues, swaps label → `in-progress`, inserts a `runs` row; also unblocks dependents and detects merged) → `scheduler` (global-semaphore FIFO; `drain()` for `/poll`, `tick()` on the interval) → `executor` (per-run state machine: `spec_plan → implementing → reviewing → pr_open`, or `→ decomposing → decomposed` for oversized issues; `failed` on any gate/throw). Each run gets an isolated `git worktree` (`src/workspace.js`, per-project async mutex around all git plumbing).

The four correctness gates are the `src/stages/*` modules (`specPlan`, `implement`, `review`, `pr`, plus `resolveConflict`). Stages shell out to `claude -p`; `gh`/`git`/`claude` are behind injectable adapters (`src/adapters/`) so every unit test runs offline with fakes — preserve this seam. Stages emit a machine-readable block parsed by `src/stages/parse.js` (`<<<RESULT … RESULT>>>` JSON); changing that contract breaks all stages.

Key cross-cutting invariants (touch carefully — they were hardened after review):
- `executor.fail()` and the review loop re-fetch the run via `getRun(runId)`; cancellation uses an `AbortController` per run with `ensureNotCancelled`/`raceAbort` checkpoints between stages — a cancel must terminate even mid-clone.
- The success path **keeps** the worktree (the PR sweep needs it); the poller's `merged` handler removes it. Only `decomposed`/`failed`/`merged` tear down.
- `decompose` creates all sub-issues, writes all `issue_deps` in one transaction, **then** applies the watch label (ordering matters: avoids a poller TOCTOU).
- `sweepWorkspacesOnStartup` is destructive on disk — it realpath-normalizes paths, refuses empty/relative `worktreesDir`, never targets a clone or a live `pr_open` worktree. Keep those guards.

## Operational gotchas (not obvious from code)

- A watched repo must have **all six labels** (`<watch-label>` + `in-progress`, `pr-open`, `failed`, `decomposed`, `merged`) before its first issue is labeled. Label swaps are `try/catch`-swallowed: a missing label means the pipeline runs but GitHub silently stops mirroring state.
- `openDb` does not `mkdir` parents. The `AUTONOMOUS_DIR` tree (`~/claude-projects/autonomous/{,projects,worktrees}` by default) must exist or the service crash-loops on boot.
- The API is eventually-consistent right after `POST /poll` — `{ok:true}` returns before the run row lands. Verify state by waiting/re-reading or querying the SQLite DB directly, not from one immediate `/runs` check.
- **`better-sqlite3` is a native module pinned to a Node ABI.** The service runs under `/home/talhabera/.local/bin/node` (Node 20, `NODE_MODULE_VERSION` 115); an interactive shell may have a different `node` (e.g. `/usr/bin/node` v22, MODVER 127). Running `npm rebuild`/`npm install` (or `npm test`, if it triggers a rebuild) with the wrong `node` recompiles `better-sqlite3` for that ABI and the **systemd service then crash-loops on boot** (`ERR_DLOPEN_FAILED`). Always rebuild with the service's node: `PATH="/home/talhabera/.local/bin:$PATH" npm rebuild better-sqlite3`, then `systemctl --user restart headless-claude.service`. Run the test suite with that same node too.

## Conventions

- Every component is a `createX({...deps})` / `buildX(...)` factory with explicit dependency injection; no module-level singletons except `loadConfig`. Tests use `openDb(':memory:')` and fake adapters.
- Config is env-only via `src/config.js` (`loadConfig(env)`); defaults live there, `.env` overrides.
- Design/plan/decision history for the autonomous subsystem lives in `docs/superpowers/` (`specs/`, `plans/`, `FOLLOWUPS-autonomous-dev.md`) — consult before changing pipeline behavior; the FOLLOWUPS file records deliberate non-goals.
- Operator-facing CLIs: `cspawn` (pool) and `cdev` (autonomous); their usage is also documented as the `cspawn` / `cdev` skills in `~/.claude/skills/`.
