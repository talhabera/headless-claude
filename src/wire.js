// src/wire.js
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createKeyedMutex } from "./mutex.js";
import { createGit } from "./adapters/git.js";
import { createGh } from "./adapters/gh.js";
import { createClaude } from "./adapters/claude.js";
import { createProjects } from "./projects.js";
import { createWorkspace } from "./workspace.js";
import { createExecutor } from "./executor.js";
import { createScheduler } from "./scheduler.js";
import { createPoller } from "./poller.js";
import { runSpecPlan } from "./stages/specPlan.js";
import { runImplement } from "./stages/implement.js";
import { runReview } from "./stages/review.js";
import { runPr } from "./stages/pr.js";
import { runResolveConflict } from "./stages/resolveConflict.js";
import { mountApi } from "./api.js";
import { reconcileOnStartup } from "./reconcile.js";
import { sweepWorkspacesOnStartup } from "./sweep.js";
import * as preview from "./preview.js";

export function buildAutonomous({ env = process.env } = {}) {
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  reconcileOnStartup(db);
  const mutex = createKeyedMutex();
  const runLock = createKeyedMutex();
  const git = createGit();
  sweepWorkspacesOnStartup({ db, git, config });
  const gh = createGh({ bin: config.ghBin });
  const claude = createClaude({
    bin: config.claudeBin,
    maxConcurrent: config.maxConcurrentRuns,
    minSpawnIntervalMs: config.claudeMinSpawnIntervalMs,
  });
  const projects = createProjects({
    db,
    git,
    projectsDir: config.projectsDir,
  });
  const workspace = createWorkspace({
    git,
    mutex,
    worktreesDir: config.worktreesDir,
  });
  const stages = {
    claude,
    runSpecPlan,
    runImplement,
    runReview,
    runPr,
    runResolveConflict,
  };
  const executor = createExecutor({
    db, gh, workspace, stages, config, git, preview, runLock,
  });
  const scheduler = createScheduler({
    db,
    executor,
    maxConcurrentRuns: config.maxConcurrentRuns,
  });
  const poller = createPoller({ db, gh, workspace });

  function mount(app) {
    mountApi(app, { db, projects, poller, scheduler, executor });
  }

  return { config, db, projects, workspace, executor, scheduler, poller, mount };
}
