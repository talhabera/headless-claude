// src/adapters/claude.js
import { spawn } from "node:child_process";

export function createClaude({ bin, baseArgs } = {}) {
  const exe = bin || "/home/talhabera/.local/bin/claude";
  const args =
    baseArgs || ["-p", "--dangerously-skip-permissions", "--output-format", "text"];
  return {
    run({ cwd, prompt, timeoutMs, signal }) {
      // If signal is already aborted, resolve immediately without spawning
      if (signal && signal.aborted) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: false, cancelled: true });
      }

      return new Promise((resolve) => {
        const child = spawn(exe, args, { cwd });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let cancelled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        const onAbort = () => {
          cancelled = true;
          child.kill("SIGKILL");
        };

        if (signal) {
          signal.addEventListener("abort", onAbort);
        }

        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ code: code === null ? 1 : code, stdout, stderr, timedOut, cancelled });
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve({ code: 1, stdout, stderr: String(e), timedOut, cancelled });
        });
        child.stdin.end(prompt);
      });
    },
  };
}
