// src/scheduler.js
export function createScheduler({ db, executor, maxConcurrentRuns }) {
  const inFlight = new Set();
  // Map from id -> promise, for awaiting in-flight work
  const promises = new Map();

  // `extraExcluded` is an optional Set supplied by drain() to dedupe runs
  // already processed within a single drain() invocation. Standalone tick()
  // does not pass it, relying on the real executor moving runs out of
  // state='queued', so no persistent state grows over the daemon's lifetime.
  function claimNext(extraExcluded) {
    const excluded = new Set(inFlight);
    if (extraExcluded) for (const id of extraExcluded) excluded.add(id);
    const row = db
      .prepare(
        `SELECT id FROM runs WHERE state='queued' AND id NOT IN (${
          [...excluded].map(() => "?").join(",") || "0"
        }) ORDER BY id LIMIT 1`,
      )
      .get(...excluded);
    return row ? row.id : null;
  }

  async function tick(extraExcluded, onSettled) {
    const launched = [];
    while (inFlight.size < maxConcurrentRuns) {
      const id = claimNext(extraExcluded);
      if (id == null) break;
      inFlight.add(id);
      const p = Promise.resolve(executor.execute(id)).finally(() => {
        inFlight.delete(id);
        promises.delete(id);
        if (onSettled) onSettled(id);
      });
      promises.set(id, p);
      launched.push(p);
    }
    return launched;
  }

  async function drain() {
    // drain-local dedupe set: garbage-collected when drain() returns,
    // so it never grows unbounded across the daemon's lifetime.
    const done = new Set();
    const onSettled = (id) => done.add(id);
    while (true) {
      const launched = await tick(done, onSettled);
      if (launched.length === 0) {
        if (inFlight.size === 0) break;
        // Race only the currently in-flight promises to avoid an infinite
        // loop with already-settled promises in an accumulating array.
        await Promise.race([...promises.values()]);
      }
    }
    await Promise.all([...promises.values()]);
  }

  return { tick, drain, inFlight };
}
