// src/mutex.js
export function createKeyedMutex() {
  const tails = new Map(); // key -> Promise chain tail
  function runExclusive(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    tails.set(key, prev.then(() => gate));
    const run = prev.then(() => fn());
    run.finally(() => {
      release();
      if (tails.get(key) && tails.get(key) !== prev) return;
    }).catch(() => {});
    return run;
  }
  return { runExclusive };
}
