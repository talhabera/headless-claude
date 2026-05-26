// src/reconcile.js
// On process start, runs left mid-flight (process died) are reset to
// 'queued' so the scheduler re-drives them from the start. Artifacts are
// preserved, so completed stages can be skipped by future smarter logic;
// for now a clean re-run from queued is correct and safe (idempotent:
// worktree add is per (issue,attempt); a stale worktree is pruned first).
const ACTIVE = ["spec_plan", "implementing", "reviewing"];

export function reconcileOnStartup(db) {
  const stranded = db
    .prepare(
      `SELECT id FROM runs WHERE state IN (${ACTIVE.map(() => "?").join(",")})`,
    )
    .all(...ACTIVE);
  const now = new Date().toISOString();
  for (const { id } of stranded) {
    db.prepare(
      "UPDATE runs SET state='queued', updated_at=? WHERE id=?",
    ).run(now, id);
    db.prepare(
      "INSERT INTO run_logs (run_id,stage,level,message,ts) VALUES (?,?,?,?,?)",
    ).run(id, "reconcile", "warn", "re-queued after restart", now);
  }
}
