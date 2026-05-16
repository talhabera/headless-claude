// src/dag.js
export function hasCycle(nodes) {
  const graph = new Map(nodes.map((n) => [n.key, n.dependsOn || []]));
  const state = new Map(); // key -> 0 unvisited,1 in-stack,2 done
  function dfs(k) {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const dep of graph.get(k) || []) {
      if (dfs(dep)) return true;
    }
    state.set(k, 2);
    return false;
  }
  for (const n of nodes) if (dfs(n.key)) return true;
  return false;
}
