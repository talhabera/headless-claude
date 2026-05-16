// src/adapters/gh.js
import { spawnSync } from "node:child_process";

function defaultRunner(bin) {
  return (args) => {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      code: r.status === null ? 1 : r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || (r.error ? r.error.message : ""),
    };
  };
}

export function createGh({ bin = "gh", runner } = {}) {
  const run = runner || defaultRunner(bin);
  const ok = (r, what) => {
    if (r.code !== 0) throw new Error(`gh ${what} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  return {
    async listLabeledIssues(repo, label) {
      const out = ok(
        run([
          "issue", "list", "-R", repo, "--label", label, "--state", "open",
          "--json", "number,title,body,state", "--limit", "100",
        ]),
        "issue list",
      );
      return JSON.parse(out || "[]");
    },
    async issue(repo, number) {
      const out = ok(
        run([
          "issue", "view", String(number), "-R", repo,
          "--json", "number,title,body,state,closed",
        ]),
        "issue view",
      );
      return JSON.parse(out);
    },
    async swapLabel(repo, number, removeLabel, addLabel) {
      ok(
        run([
          "issue", "edit", String(number), "-R", repo,
          "--remove-label", removeLabel,
        ]),
        "remove label",
      );
      ok(
        run([
          "issue", "edit", String(number), "-R", repo,
          "--add-label", addLabel,
        ]),
        "add label",
      );
    },
    async setLabel(repo, number, addLabel) {
      ok(
        run(["issue", "edit", String(number), "-R", repo, "--add-label", addLabel]),
        "add label",
      );
    },
    async comment(repo, number, body) {
      ok(
        run(["issue", "comment", String(number), "-R", repo, "--body", body]),
        "comment",
      );
    },
    async createIssue(repo, { title, body }) {
      const out = ok(
        run(["issue", "create", "-R", repo, "--title", title, "--body", body]),
        "issue create",
      );
      const m = out.match(/\/issues\/(\d+)/);
      return { number: m ? Number(m[1]) : null, url: out.trim() };
    },
    async createPR(repo, { head, base, title, body }) {
      const out = ok(
        run([
          "pr", "create", "-R", repo, "--head", head, "--base", base,
          "--title", title, "--body", body,
        ]),
        "pr create",
      );
      return { url: out.trim() };
    },
    async prStatus(repo, head) {
      const out = ok(
        run([
          "pr", "view", head, "-R", repo,
          "--json", "state,mergeable,mergeStateStatus,number,url",
        ]),
        "pr view",
      );
      return JSON.parse(out);
    },
  };
}
