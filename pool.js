import { exec } from "node:child_process";
import { promisify } from "node:util";

const sh = promisify(exec);
const PREFIX = "claude-slot-";

async function tmuxList() {
  try {
    // history_size is the scrollback line count of the pane, which only grows
    // when content scrolls out of view — a reliable "this slot has been used" signal.
    const { stdout } = await sh(
      `tmux list-panes -a -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{history_size}\t#{session_path}'`,
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((l) => l.split("\t")[0].startsWith(PREFIX))
      .map((l) => {
        const [name, created, attached, history, path] = l.split("\t");
        const createdSec = Number(created);
        const historySize = Number(history);
        return {
          id: name.slice(PREFIX.length),
          name,
          createdAt: new Date(createdSec * 1000).toISOString(),
          attached: Number(attached) > 0,
          historySize,
          fresh: historySize === 0,
          path,
        };
      })
      .sort((a, b) => Number(a.id) - Number(b.id));
  } catch {
    return [];
  }
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || "/home/talhabera/.local/bin/claude";
const TMUX_SERVER_UNIT = "tmux-claude-pool";
const KEEPALIVE_SESSION = "__claude_pool_keepalive__";

// Bootstrap the tmux server in its own transient user service so its lifecycle
// is independent of our pool service's cgroup. The keepalive session ensures
// the server doesn't exit when all claude-slot-* sessions are killed.
export async function ensureTmuxServer() {
  try {
    await sh(`tmux has-session -t ${KEEPALIVE_SESSION}`);
    return;
  } catch {}
  await sh(
    `systemd-run --user --quiet --unit=${TMUX_SERVER_UNIT} --service-type=forking --property=KillMode=process -- tmux new-session -d -s ${KEEPALIVE_SESSION} sleep infinity`,
  );
}

async function tmuxSpawn(id, cwd) {
  await ensureTmuxServer();
  await sh(
    `tmux new-session -d -s ${PREFIX}${id} -c ${shellEscape(cwd)} ${shellEscape(CLAUDE_BIN)}`,
  );
  await dismissStartupPrompts(`${PREFIX}${id}`);
}

async function dismissStartupPrompts(session) {
  // claude shows a "trust this folder" prompt the first time it's launched
  // in a new directory. After accepting once, the choice is saved.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 600));
    let pane = "";
    try {
      pane = (await sh(`tmux capture-pane -t ${session} -p`)).stdout;
    } catch {
      return;
    }
    if (pane.includes("trust this folder")) {
      try { await sh(`tmux send-keys -t ${session} Enter`); } catch {}
      continue;
    }
    return;
  }
}

async function tmuxKill(id) {
  try {
    await sh(`tmux kill-session -t ${PREFIX}${id}`);
  } catch {}
}

function shellEscape(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

export class TmuxPool {
  constructor({ cwds, max = 10 } = {}) {
    if (!Array.isArray(cwds) || cwds.length === 0) {
      throw new Error("TmuxPool requires non-empty cwds array");
    }
    this.cwds = cwds.map((c) => ({ cwd: c.cwd, target: c.target ?? 1 }));
    this.max = max;
    this.nextNum = 1;
  }

  async list() {
    return tmuxList();
  }

  totalTarget() {
    return this.cwds.reduce((a, c) => a + c.target, 0);
  }

  async ensurePool() {
    const added = [];
    // Spawn up to POOL_MAX total slots, ensuring each configured cwd has at
    // least its target count of fresh (history_size === 0) slots.
    for (let i = 0; i < this.max + 1; i++) {
      const current = await tmuxList();
      const missing = this.cwds.find(
        (c) => current.filter((s) => s.fresh && s.path === c.cwd).length < c.target,
      );
      if (!missing) {
        const fresh = current.filter((s) => s.fresh).length;
        return { added, fresh, total: current.length };
      }
      if (current.length >= this.max) {
        const fresh = current.filter((s) => s.fresh).length;
        return { added, fresh, total: current.length, reason: `at max (${this.max})` };
      }
      const id = this.allocId(current);
      try {
        await tmuxSpawn(id, missing.cwd);
        this.nextNum = Math.max(this.nextNum, Number(id) + 1);
      } catch (err) {
        return { added, reason: `spawn failed: ${err.message}` };
      }
      const after = await tmuxList();
      if (!after.some((s) => s.id === id)) {
        return { added, reason: `slot ${id} died immediately after spawn` };
      }
      added.push(`${PREFIX}${id} (${missing.cwd})`);
    }
    return { added, reason: "iteration cap reached" };
  }

  allocId(current) {
    const used = new Set(current.map((s) => parseInt(s.id, 10)));
    while (used.has(this.nextNum)) this.nextNum++;
    return String(this.nextNum);
  }

  async spawnOne(cwd) {
    const current = await tmuxList();
    if (current.length >= this.max) return { ok: false, reason: `at max (${this.max})` };
    const target = cwd || this.cwds[0].cwd;
    const id = this.allocId(current);
    try {
      await tmuxSpawn(id, target);
      this.nextNum = Math.max(this.nextNum, Number(id) + 1);
      return { ok: true, name: `${PREFIX}${id}`, id, cwd: target };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async kill(id) {
    const sessions = await tmuxList();
    if (!sessions.some((s) => s.id === id)) return { ok: false, reason: "no such slot" };
    try {
      await tmuxKill(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
}
