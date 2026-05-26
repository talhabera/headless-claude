import express from "express";
import { randomBytes } from "node:crypto";
import { TmuxPool } from "./pool.js";
import { buildAutonomous } from "./src/wire.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const POOL_TARGET = parseInt(process.env.POOL_TARGET || "2", 10);
const POOL_MAX = parseInt(process.env.POOL_MAX || "10", 10);
const WATCHDOG_MS = parseInt(process.env.WATCHDOG_MS || "15000", 10);
let AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const POOL_CWD = process.env.POOL_CWD || "/home/talhabera/claude-projects";
// POOL_CWDS is JSON: [{"cwd": "...", "target": 1}, ...]
// Falls back to a single entry from POOL_CWD/POOL_TARGET.
const POOL_CWDS = process.env.POOL_CWDS
  ? JSON.parse(process.env.POOL_CWDS)
  : [{ cwd: POOL_CWD, target: POOL_TARGET }];

const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
if (!isLoopback && !AUTH_TOKEN) {
  console.error(
    `refusing to bind ${HOST} without AUTH_TOKEN — set AUTH_TOKEN env var or bind to 127.0.0.1`,
  );
  process.exit(1);
}
if (isLoopback && !AUTH_TOKEN) {
  AUTH_TOKEN = randomBytes(16).toString("hex");
  console.log(`generated AUTH_TOKEN for this run: ${AUTH_TOKEN}`);
}

const pool = new TmuxPool({ cwds: POOL_CWDS, max: POOL_MAX });

async function reconcile(source) {
  const r = await pool.ensurePool();
  if (r.added.length) console.log(`[${source}] added ${r.added.join(",")}`);
  if (r.reason) console.log(`[${source}] ${r.reason}`);
  return r;
}

await reconcile("startup");
setInterval(() => reconcile("watchdog").catch((e) => console.error("watchdog err:", e.message)), WATCHDOG_MS).unref();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/static") || req.path === "/healthz") return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const autonomous = buildAutonomous({ env: process.env });
autonomous.mount(app);

setInterval(
  () =>
    autonomous.poller
      .tick()
      .then(() => autonomous.scheduler.tick())
      .catch((e) => console.error("poll/sched err:", e.message)),
  autonomous.config.issuePollMs,
).unref();

console.log(
  `autonomous-dev wired: poll=${autonomous.config.issuePollMs}ms maxRuns=${autonomous.config.maxConcurrentRuns}`,
);

app.get("/status", async (_req, res) => {
  const slots = await pool.list();
  res.json({
    target: pool.totalTarget(),
    max: POOL_MAX,
    cwds: POOL_CWDS,
    perCwd: POOL_CWDS.map((c) => ({
      cwd: c.cwd,
      target: c.target,
      fresh: slots.filter((s) => s.fresh && s.path === c.cwd).length,
      total: slots.filter((s) => s.path === c.cwd).length,
    })),
    count: slots.length,
    fresh: slots.filter((s) => s.fresh).length,
    used: slots.filter((s) => !s.fresh).length,
    attached: slots.filter((s) => s.attached).length,
    slots,
  });
});

app.post("/spawn", async (req, res) => {
  const r = await pool.spawnOne(req.body?.cwd);
  res.status(r.ok ? 200 : 409).json(r);
});

app.post("/kill/:id", async (req, res) => {
  const r = await pool.kill(req.params.id);
  await reconcile("kill");
  res.status(r.ok ? 200 : 409).json(r);
});

app.post("/reconcile", async (_req, res) => {
  const r = await reconcile("manual");
  res.json(r);
});

app.listen(PORT, HOST, () => {
  const cwdSummary = POOL_CWDS.map((c) => `${c.cwd}=${c.target}`).join(",");
  console.log(
    `headless-claude on ${HOST}:${PORT}  max=${POOL_MAX}  watchdog=${WATCHDOG_MS}ms  cwds=[${cwdSummary}]  auth=on`,
  );
});
