// src/adapters/claude.js
import { spawn } from "node:child_process";

export function createClaude({ bin, baseArgs } = {}) {
  const exe = bin || "/home/talhabera/.local/bin/claude";
  const args =
    baseArgs || ["-p", "--dangerously-skip-permissions", "--output-format", "text"];
  return {
    run({ cwd, prompt, timeoutMs }) {
      return new Promise((resolve) => {
        const child = spawn(exe, args, { cwd });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code === null ? 1 : code, stdout, stderr, timedOut });
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ code: 1, stdout, stderr: String(e), timedOut });
        });
        child.stdin.end(prompt);
      });
    },
  };
}
