// src/adapters/git.js
import { spawnSync } from "node:child_process";

export function createGit(bin = "git") {
  return function git(cwd, args, opts = {}) {
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      code: r.status === null ? 1 : r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || (r.error ? r.error.message : ""),
    };
  };
}
