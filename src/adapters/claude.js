// src/adapters/claude.js
import { spawn } from "node:child_process";

function createSemaphore(max) {
  let inFlight = 0;
  const waiters = [];
  return {
    async acquire() {
      if (inFlight < max) { inFlight++; return; }
      await new Promise((r) => waiters.push(r));
      inFlight++;
    },
    release() {
      inFlight--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

export function createClaude({
  bin,
  baseArgs,
  maxConcurrent = Infinity,
  minSpawnIntervalMs = 0,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  _spawn,            // test seam: when set, replaces the actual child_process.spawn path
} = {}) {
  const exe = bin || "/home/talhabera/.local/bin/claude";
  const args =
    baseArgs || ["-p", "--dangerously-skip-permissions", "--output-format", "text"];

  const sem = createSemaphore(maxConcurrent);
  let lastSpawnAt = -Infinity;

  async function applyPacing() {
    const wait = Math.max(0, lastSpawnAt + minSpawnIntervalMs - now());
    if (wait > 0) {
      // Single line, only on the wait path. Operator visibility.
      // eslint-disable-next-line no-console
      console.log(`claude: spawn paced +${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    lastSpawnAt = now();
  }

  function realSpawn({ cwd, prompt, timeoutMs, signal }) {
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

      const onAbort = () => { cancelled = true; child.kill("SIGKILL"); };
      if (signal) signal.addEventListener("abort", onAbort);

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
  }

  return {
    async run(opts) {
      const { signal } = opts || {};
      if (signal && signal.aborted) {
        return { code: 1, stdout: "", stderr: "", timedOut: false, cancelled: true };
      }
      await sem.acquire();
      try {
        await applyPacing();
        return await (_spawn ? _spawn(opts) : realSpawn(opts));
      } finally {
        sem.release();
      }
    },
  };
}
