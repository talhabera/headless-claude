// src/runCooldown.js
// Single source of truth for the per-run cooldown math.
//
// Lifecycle:
//   recordSuccess → consecutive_failures = 0;
//                   next_attempt_at = now + runCooldownMs
//   recordFailure → consecutive_failures += 1;
//                   next_attempt_at = now + min(runCooldownMs * (1 + cf),
//                                               runCooldownMaxMs)

export function recordSuccess(db, runId, cfg, nowMs = Date.now()) {
  const next = new Date(nowMs + cfg.runCooldownMs).toISOString();
  db.prepare(
    "UPDATE runs SET consecutive_failures=0, next_attempt_at=?, updated_at=? WHERE id=?",
  ).run(next, new Date(nowMs).toISOString(), runId);
}

export function recordFailure(db, runId, cfg, nowMs = Date.now()) {
  const row = db
    .prepare("SELECT consecutive_failures FROM runs WHERE id=?")
    .get(runId);
  const failures = (row && row.consecutive_failures ? row.consecutive_failures : 0) + 1;
  const delay = Math.min(cfg.runCooldownMs * (1 + failures), cfg.runCooldownMaxMs);
  const next = new Date(nowMs + delay).toISOString();
  db.prepare(
    "UPDATE runs SET consecutive_failures=?, next_attempt_at=?, updated_at=? WHERE id=?",
  ).run(failures, next, new Date(nowMs).toISOString(), runId);
}
