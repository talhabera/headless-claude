// src/config.js
import { join } from "node:path";

const num = (v, d) => (v === undefined ? d : parseInt(v, 10));
const bool = (v, d) => (v === undefined ? d : v === "true");

export function loadConfig(env = process.env) {
  const home = env.HOME || "/home/talhabera";
  const root = env.AUTONOMOUS_DIR || join(home, "claude-projects", "autonomous");
  return {
    projectsDir: env.PROJECTS_DIR || join(root, "projects"),
    worktreesDir: env.WORKTREES_DIR || join(root, "worktrees"),
    dbPath: env.DB_PATH || join(root, "autonomous.db"),
    issuePollMs: num(env.ISSUE_POLL_MS, 30000),
    prSyncMs: num(env.PR_SYNC_MS, 60000),
    maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 2),
    stageTimeoutMs: num(env.STAGE_TIMEOUT_MS, 1800000),
    keepFailedWorktree: bool(env.KEEP_FAILED_WORKTREE, false),
    ghBin: env.GH_BIN || "gh",
    claudeBin: env.CLAUDE_BIN || "/home/talhabera/.local/bin/claude",
    previewDeployTimeoutMs: num(env.PREVIEW_DEPLOY_TIMEOUT_MS, 600000),
    previewPollMs: num(env.PREVIEW_POLL_MS, 10000),
    prReviewMs: num(env.PR_REVIEW_MS, 120000),
    prReviewMaxIterations: num(env.PR_REVIEW_MAX_ITERATIONS, 4),
    botLogin: env.PR_BOT_LOGIN || "",
  };
}
