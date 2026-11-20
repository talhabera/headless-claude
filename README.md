# headless-claude

A small Node service that runs the Claude Code CLI unattended on a Linux box. It does two things in one process:

1. **Session pool.** Keeps a set of warm `claude` tmux sessions alive per working directory, so a session is always ready to attach to.
2. **Autonomous issue-to-PR bot.** Watches registered GitHub repos for a label, and takes each labeled issue through spec, implementation, review and a pull request without a human in the loop.

Runtime dependencies are `express` and `better-sqlite3`. There is no build step.

## How the issue-to-PR pipeline works

SQLite is the source of truth for every run. GitHub labels only mirror the state, so the bot survives a restart without losing track of work.

```
labeled issue
   -> poller      claims the issue, swaps the label to in-progress, inserts a run
   -> scheduler   FIFO queue behind a global concurrency limit
   -> executor    per-run state machine:
                  queued -> spec_plan -> implementing -> reviewing -> previewing -> pr_open
   -> poller      sees the issue closed -> merged, removes the worktree
```

Each stage shells out to `claude -p` inside a git worktree dedicated to that run. The stages are separate modules in `src/stages/`:

| Stage | What it does |
| --- | --- |
| `specPlan` | Turns the issue into a spec and an implementation plan |
| `implement` | Writes the code against a recorded test baseline |
| `review` | Reviews the diff and loops back to implementation on findings |
| `resolveConflict` | Rebases onto the base branch and resolves conflicts mid-run |
| `pr` | Pushes the branch and opens the pull request |

Once a run reaches `pr_open` the bot stops touching it. Review and merge stay with a person.

Things the pipeline handles on purpose:

- **Cancellation.** Every run has an `AbortController`, checked between stages, so a cancel terminates even in the middle of a clone.
- **Restart safety.** On boot the service reconciles in-flight runs and sweeps orphaned worktrees. The sweep refuses relative or empty paths and never deletes a clone or the worktree of an open PR.
- **Rate limits.** A minimum interval between `claude` spawns and an exponential cooldown per run keep the bot inside usage limits.
- **Preview deployments.** A project can name a preview branch and URL; the run waits for the deployment before opening the PR.

## Requirements

- Node 20
- `tmux`, `git`, the GitHub CLI (`gh`, authenticated) and the Claude Code CLI (`claude`) on the host

## Setup

```bash
npm install
cp .env.example .env
mkdir -p ~/claude-projects/autonomous/{projects,worktrees}
npm start
```

The server binds `127.0.0.1:3000` by default. On loopback it generates a bearer token at startup if `AUTH_TOKEN` is empty. It refuses to bind a non-loopback host without a token.

Several defaults (`POOL_CWD`, `CLAUDE_BIN`, the paths in `headless-claude.service`, `cdev` and `cspawn`) point at the author's home directory. Override them in `.env` or edit the unit file for your machine.

To run it as a daemon, install `headless-claude.service` as a systemd user unit. The unit uses `KillMode=process`, so restarting the service leaves the tmux sessions running.

## Configuration

All configuration comes from environment variables. Defaults are in `src/config.js` and `server.js`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Bind address |
| `AUTH_TOKEN` | generated on loopback | Bearer token for every endpoint except `/` and `/healthz` |
| `POOL_CWDS` | one entry from `POOL_CWD` | JSON list of `{cwd, target}` pool entries |
| `POOL_MAX` | `10` | Hard cap on pool sessions |
| `AUTONOMOUS_DIR` | `~/claude-projects/autonomous` | Root for clones, worktrees and the SQLite file |
| `ISSUE_POLL_MS` | `30000` | Poll and schedule interval |
| `MAX_CONCURRENT_RUNS` | `2` | Global run concurrency |
| `STAGE_TIMEOUT_MS` | `1800000` | Timeout for one stage |
| `RUN_COOLDOWN_MS` | `180000` | Base cooldown before a run is retried |

## Usage

Register a repo and let the bot pick up issues:

```bash
./cdev add owner/repo --label claude-dev --base main
./cdev projects
./cdev runs --state failed
./cdev logs <run-id>
./cdev retry <run-id>
./cdev poll
```

A watched repo needs five labels before its first issue is labeled: the watch label plus `in-progress`, `pr-open`, `failed` and `merged`.

Spawn a pool session in a directory:

```bash
./cspawn ~/code/my-project
./cspawn -a ~/code/my-project   # also prints the tmux attach command
```

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, no auth |
| `GET /status` | Pool sessions |
| `POST /spawn`, `POST /kill/:id`, `POST /reconcile` | Pool control |
| `POST /projects`, `GET /projects`, `DELETE /projects/:slug` | Watched repos |
| `GET /runs`, `GET /runs/:id` | Runs and their logs |
| `POST /runs/:id/retry`, `POST /runs/:id/cancel` | Run control |
| `POST /poll` | Force a poll and schedule tick |

`public/index.html` is a small dashboard over the same API.

## Tests

```bash
npm test
```

The suite uses Node's built-in test runner: 51 files covering each stage, the executor state machine, cancellation, cooldowns, and end-to-end scenarios (happy path, burst labeling, restart persistence). `gh`, `git` and `claude` sit behind injectable adapters in `src/adapters/`, and the database opens in memory, so the tests need no network and no CLI installed. `better-sqlite3` is a native module, so run the tests with the same Node major version you installed with.

## Design notes

Specs, plans and deliberate non-goals for the autonomous subsystem are in `docs/superpowers/`.
