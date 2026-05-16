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
import { createPrSweep } from "./prSweep.js";
import { decompose } from "./decompose.js";
import { runSpecPlan } from "./stages/specPlan.js";
import { runImplement } from "./stages/implement.js";
import { runReview } from "./stages/review.js";
import { runPr } from "./stages/pr.js";
import { runResolveConflict } from "./stages/resolveConflict.js";
import { mountApi } from "./api.js";
import { reconcileOnStartup } from "./reconcile.js";

export function buildAutonomous({ env = process.env } = {}) {
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  reconcileOnStartup(db);
  const mutex = createKeyedMutex();
  const git = createGit();
  const gh = createGh({ bin: config.ghBin });
  const claude = createClaude({ bin: config.claudeBin });
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
    db, gh, workspace, stages, decompose, config,
  });
  const scheduler = createScheduler({
    db,
    executor,
    maxConcurrentRuns: config.maxConcurrentRuns,
  });
  const poller = createPoller({ db, gh, workspace });
  const prSweep = createPrSweep({ db, gh, workspace, stages, config });

  function mount(app) {
    mountApi(app, { db, projects, poller, scheduler });
  }

  return { config, db, projects, workspace, executor, scheduler, poller, prSweep, mount };
}
