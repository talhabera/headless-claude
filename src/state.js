// src/state.js
export const LABEL_FOR = {
  queued: "in-progress",
  blocked: "in-progress",
  spec_plan: "in-progress",
  implementing: "in-progress",
  reviewing: "in-progress",
  decomposing: "in-progress",
  pr_open: "pr-open",
  decomposed: "decomposed",
  merged: "merged",
  failed: "failed",
};

export const TERMINAL = new Set(["pr_open", "decomposed", "merged", "failed"]);

export function transition(db, runId, newState, log = {}) {
  const now = new Date().toISOString();
  db.prepare("UPDATE runs SET state=?, updated_at=? WHERE id=?").run(
    newState,
    now,
    runId,
  );
  db.prepare(
    "INSERT INTO run_logs (run_id,stage,level,message,ts) VALUES (?,?,?,?,?)",
  ).run(runId, log.stage || newState, log.level || "info", log.message || "", now);
}
