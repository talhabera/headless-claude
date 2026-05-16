// src/scheduler.js
export function createScheduler({ db, executor, maxConcurrentRuns }) {
  const inFlight = new Set();
  const done = new Set();
  // Map from id -> promise, for awaiting in-flight work
  const promises = new Map();

  function claimNext() {
    const excluded = new Set([...inFlight, ...done]);
    const row = db
      .prepare(
        `SELECT id FROM runs WHERE state='queued' AND id NOT IN (${
          [...excluded].map(() => "?").join(",") || "0"
        }) ORDER BY id LIMIT 1`,
      )
      .get(...excluded);
    return row ? row.id : null;
  }

  async function tick() {
    const launched = [];
    while (inFlight.size < maxConcurrentRuns) {
      const id = claimNext();
      if (id == null) break;
      inFlight.add(id);
      const p = Promise.resolve(executor.execute(id)).finally(() => {
        inFlight.delete(id);
        done.add(id);
        promises.delete(id);
      });
      promises.set(id, p);
      launched.push(p);
    }
    return launched;
  }

  async function drain() {
    let all = [];
    while (true) {
      const launched = await tick();
      all = all.concat(launched);
      if (launched.length === 0) {
        if (inFlight.size === 0) break;
        // Race only the currently in-flight promises to avoid infinite loop
        // with already-settled promises
        await Promise.race([...promises.values()]);
      }
    }
    await Promise.all(all);
  }

  return { tick, drain, inFlight };
}
