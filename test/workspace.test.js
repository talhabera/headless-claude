// test/workspace.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyedMutex } from "../src/mutex.js";
import { createWorkspace } from "../src/workspace.js";

function scriptedGit(map) {
  const calls = [];
  const git = (cwd, args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    for (const [m, res] of map) if (key.includes(m)) return res;
    return { code: 0, stdout: "", stderr: "" };
  };
  git.calls = calls;
  return git;
}

const project = {
  slug: "o-r",
  local_path: "/clones/o-r",
  base_branch: "main",
};

test("prepareClone fetches and fast-forwards base", async () => {
  const git = scriptedGit([]);
  const ws = createWorkspace({
    git,
    mutex: createKeyedMutex(),
    worktreesDir: "/wt",
  });
  await ws.prepareClone(project);
  assert.ok(git.calls.some((c) => /fetch origin/.test(c)));
  assert.ok(git.calls.some((c) => /checkout main/.test(c)));
  assert.ok(git.calls.some((c) => /reset --hard origin\/main/.test(c)));
});

test("addWorktree creates branch off base and returns path", async () => {
  const git = scriptedGit([]);
  const ws = createWorkspace({
    git,
    mutex: createKeyedMutex(),
    worktreesDir: "/wt",
  });
  const r = await ws.addWorktree(project, { issue_number: 7, attempt: 1 });
  assert.equal(r.branch, "claude/7-o-r");
  assert.equal(r.path, "/wt/o-r-7-1");
  assert.ok(
    git.calls.some((c) =>
      /worktree add \/wt\/o-r-7-1 -b claude\/7-o-r origin\/main/.test(c),
    ),
  );
});

test("rebaseOnBase reports conflict with files", async () => {
  const git = scriptedGit([
    ["rebase origin/main", { code: 1, stdout: "", stderr: "CONFLICT" }],
    [
      "diff --name-only --diff-filter=U",
      { code: 0, stdout: "a.js\nb.js\n", stderr: "" },
    ],
  ]);
  const ws = createWorkspace({
    git,
    mutex: createKeyedMutex(),
    worktreesDir: "/wt",
  });
  const r = await ws.rebaseOnBase(project, "/wt/o-r-7-1");
  assert.equal(r.conflicted, true);
  assert.deepEqual(r.files, ["a.js", "b.js"]);
});
