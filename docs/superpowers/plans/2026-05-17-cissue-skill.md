# cissue Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author `~/.claude/skills/cissue/SKILL.md` — a single-file process skill that turns a user request into well-formed, agent-ready GitHub issues for the headless-claude/cdev autonomous pipeline, with preflight, draft→confirm→create, and dependency-ordered decomposition.

**Architecture:** A documentation-only skill (no executable code), structurally and stylistically consistent with the sibling `~/.claude/skills/cdev/SKILL.md` and `~/.claude/skills/cspawn/SKILL.md`: YAML frontmatter (`name`, trigger-rich `description`) + a Markdown body that instructs the agent through a fixed 6-step workflow, the agent-ready issue template, sizing/decomposition + dependency rules, preflight, and safety/edge cases. "Tests" are structural/behavioral verifications, not unit tests.

**Tech Stack:** Markdown + YAML frontmatter. Reference tools the skill body invokes: `cdev` CLI, `gh` CLI. No build, no runtime.

**Spec:** `docs/superpowers/specs/2026-05-17-cissue-skill-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `~/.claude/skills/cissue/SKILL.md` | The entire skill: frontmatter + workflow + issue template + decomposition + preflight + safety | Create |

Single artifact. No tests directory (process skill). Verification is done by inspecting the file and dry-running a scenario against it.

The design spec lives in the `headless-claude` git repo (`docs/superpowers/specs/`) and is committed there for history; the **runtime skill artifact** is created at `~/.claude/skills/cissue/SKILL.md` (the personal skills dir, not a git repo — same as `cdev`/`cspawn`, which are intentionally not version-controlled). Plan commits therefore cover the spec/plan docs in the headless-claude repo; the SKILL.md itself is delivered to the skills dir and verified in place.

---

## Task 1: Author `~/.claude/skills/cissue/SKILL.md`

**Files:**
- Create: `/home/talhabera/.claude/skills/cissue/SKILL.md`
- Reference (read for house style, do not modify): `/home/talhabera/.claude/skills/cdev/SKILL.md`, `/home/talhabera/.claude/skills/cspawn/SKILL.md`

- [ ] **Step 1: Confirm the sibling house style**

Run: `sed -n '1,6p' /home/talhabera/.claude/skills/cdev/SKILL.md`
Expected: a YAML frontmatter block delimited by `---`, with `name:` and a long `description:` that enumerates trigger phrases ("This skill should be used when the user asks to ..."), then a `#` H1 title line. Match this exact shape (frontmatter keys, description phrasing pattern, `[[cdev]]`-style wikilink cross-references, operational-checklist tone).

- [ ] **Step 2: Create the skill directory**

Run: `mkdir -p /home/talhabera/.claude/skills/cissue`
Expected: no output; directory exists.

- [ ] **Step 3: Write `~/.claude/skills/cissue/SKILL.md`**

Create `/home/talhabera/.claude/skills/cissue/SKILL.md` with EXACTLY this content:

````markdown
---
name: cissue
description: This skill should be used when the user asks to "create an issue", "create issues", "file an issue for <project>", "make agent-ready issues", "open issues on the bot", "cissue", "add a task for the acme project", "queue work for cdev", or any variation about creating GitHub issues for the headless-claude/cdev autonomous dev system on a registered project. Produces one or more well-scoped, agent-ready issues (auto-decomposing big requests into dependency-ordered sub-issues) and labels them for the pipeline.
---

# cissue — create agent-ready GitHub issues for the cdev autonomous pipeline

The user runs the headless-claude autonomous-dev subsystem (see the [[cdev]]
skill). It watches registered repos for a watch label; a labeled issue is
developed on an isolated worktree through a gated pipeline
(spec+plan → TDD implement → independent review → preview gate → PR). The
quality of the **issue** decides whether a run succeeds: the independent
review stage verifies every acceptance-criteria item against the diff, and
the implement stage is bounded by a baseline-relative gate. This skill turns
a user request into issues that pipeline can actually land.

This is the **authoring** counterpart to [[cdev]] (which is the control
plane: register/list/runs/logs/poll). Use [[cdev]] for "watch this repo" or
"why did run 7 fail"; use this skill for "create issue(s) for <project>".

## When to use

Trigger on requests to create work for the bot: "create an issue for the
acme project", "file these 3 tasks on <repo>", "make an agent-ready issue
to ...", "cissue", "queue this for cdev". Do **not** trigger for: registering
projects (that is `cdev add`), inspecting runs (that is `cdev runs`/`logs`),
or non-cdev GitHub issues.

## Workflow (do every step, in order)

### 1. Resolve & preflight the target project (HARD GATE)

Issues filed against an unwatched repo, or with missing labels, silently fail
to drive the pipeline. Before drafting anything:

1. `cdev projects` — parse the JSON. Match the user's named project to a
   registered entry. If the service/`cdev` is unreachable
   (`AUTH_TOKEN not set`, connection refused): STOP, surface it, point at
   [[cdev]] recovery (`systemctl --user restart headless-claude.service`).
   Do not create issues blind.
2. If no project matches: STOP. Tell the user it is not registered; suggest
   `cdev add <owner/repo> --label <L> --base <B>`. Do not file issues.
3. From the matched project record read the REAL values — never hardcode:
   `repo` (`owner/name`), `base_branch`, `watch_label`.
4. Ensure all six labels exist in `repo` (idempotent — the documented
   silent-failure trap from [[cdev]]):
   ```bash
   R=<repo>; W=<watch_label>
   gh label create "$W" -R $R --color 1f6feb --description "headless-claude: develop this issue" 2>/dev/null || true
   for L in in-progress:fbca04 pr-open:0e8a16 failed:d73a4a decomposed:5319e7 merged:c2e0c6; do
     gh label create "${L%%:*}" -R $R --color "${L##*:}" --description "headless-claude state" 2>/dev/null || true
   done
   ```

### 2. Intake

Take the user's request — one idea or a list. Ask clarifying questions ONLY
when genuinely ambiguous (unclear acceptance, unknown target area, or a
request whose size you cannot judge). Do not run a fixed Q&A for simple,
clear requests.

### 3. Shape & size

Turn each item into the **agent-ready issue template** (below). Apply the
**sizing & decomposition rules** (below): split anything multi-concern or
large into independently-shippable, dependency-ordered sub-issues.

### 4. Draft → confirm (outward-action checkpoint)

Show the user the full draft of every issue (title + body) AND the
decomposition/dependency plan (which are independent, which block which,
which get labeled now vs held). Create NOTHING until the user approves or
edits. This confirm step is mandatory — filing public GitHub issues is
outward-facing.

### 5. Create & label

For each approved issue, in dependency order:
- `gh issue create -R <repo> --title "<title>" --body "<body>"` (capture the
  returned issue URL/number).
- Apply the watch label ONLY to dependency-free issues now:
  `gh issue edit <n> -R <repo> --add-label <watch_label>` (or pass
  `--label <watch_label>` directly on create for unblocked ones).
- Blocked sub-issues: create them but DO NOT label them; their body must
  contain a `Depends on: #<n>` line naming each prerequisite issue.
- Optionally `cdev poll` so the pipeline claims the unblocked ones now.

### 6. Report

Output a table: issue number, URL, title, and **labeled-live | held-blocked**.
For each held-blocked issue list its prerequisite issue number(s) and the
exact release command:
`gh issue edit <n> -R <repo> --add-label <watch_label>`
(run it after the prerequisite's PR is merged). State whether `cdev poll`
was run, and remind: track with `cdev runs` / `cdev logs <id>`.

## Agent-ready issue template

Every issue you file uses EXACTLY this structure:

```
<concise imperative scoped title>

## Problem
<1–3 concrete sentences: what is wrong/needed and why>

## Scope
<the exact bounded change; name files/paths/areas when known; state the
kind of change: i18n-only / copy-only / config-only / component-X-only>

## Acceptance criteria
- [ ] <objectively verifiable, unambiguous, testable statement>
- [ ] <...>

## Out of scope
<explicit exclusions; when other in-flight issues/PRs touch files, add an
explicit "do not modify <files>" line>

## Constraints
- Baseline-relative gate: do NOT fix unrelated pre-existing
  lint/typecheck/build failures to chase whole-repo green; only your change
  must introduce zero new failures.
- <"no behavior change" when applicable>
- <any "X-only" restriction>
```

The **Acceptance criteria** checklist is load-bearing: the independent review
stage verifies each item against the committed diff line-by-line. Each item
must be unambiguous and objectively checkable (counts, exact strings, file
lists — not "looks good"). The **Constraints** baseline-gate line is
mandatory in every issue — its omission is what bounced earlier runs.

## Sizing & decomposition rules

- Right size = one focused single-concern change a TDD implement→review
  cycle can land cleanly: one area/concern, a small bounded acceptance
  checklist, no "and also".
- Multi-concern/large → split into sub-issues; each independently shippable
  and individually template-formed.
- Prefer the lowest-risk slice when a goal can be staged
  (i18n/content/config-only first — these clear the baseline gate cleanly).
- Dependency handling: the pipeline's internal dependency tracking is
  populated only by its OWN auto-decomposer, not by externally-created
  issues. So: create ALL sub-issues; label only the dependency-free ones
  now; leave blocked ones UNLABELED with `Depends on: #<n>` in the body;
  report the release one-liner for each. This yields correct ordering
  without fighting the pipeline model.

## Safety / edge cases

- Draft→confirm is the outward-action checkpoint; nothing is filed before
  the user approves.
- Duplicate guard: `gh issue list -R <repo> --state open` and warn (do not
  double-file) if a near-identical title already exists.
- Collision guard: if the project has open bot PRs/issues touching the same
  files, add an explicit `Out of scope: do not modify <files>` line.
- Service/`cdev` unreachable → surface + [[cdev]] recovery; never create
  issues blind.
- This skill NEVER merges, NEVER edits existing issues' content, and only
  ever applies the watch label (plus creating the six labels). Minimal
  blast radius.

## Failure modes to recognize

- `cdev projects` errors / connection refused → service down; see [[cdev]].
- Project not registered → do not file; suggest `cdev add`.
- `gh` not authenticated for `repo` → `gh auth status`; fix before filing.
- Labeled an issue but `cdev runs` shows nothing → API is
  eventually-consistent right after a poll; wait/re-check (see [[cdev]]).
````

- [ ] **Step 4: Verify frontmatter validity**

Run:
```bash
python3 -c "import sys,yaml; d=open('/home/talhabera/.claude/skills/cissue/SKILL.md').read(); b=d.split('---'); fm=yaml.safe_load(b[1]); print('name=',fm['name']); assert fm['name']=='cissue'; assert 'cissue' in fm['description'] and 'create' in fm['description'].lower(); print('frontmatter OK, description len=',len(fm['description']))"
```
Expected: prints `name= cissue` and `frontmatter OK, description len= <N>` with N > 120 (trigger-rich, comparable to cdev's). No exception.

- [ ] **Step 5: Verify structural completeness**

Run (prefix match — headings may carry parenthetical suffixes like
`## Workflow (do every step, in order)`, so do NOT `$`-anchor):
```bash
grep -cE '^## (When to use|Workflow|Agent-ready issue template|Sizing & decomposition rules|Safety / edge cases|Failure modes to recognize)' /home/talhabera/.claude/skills/cissue/SKILL.md
```
Expected: `6` (all six required H2 sections present).

Run:
```bash
grep -qE 'Baseline-relative gate' /home/talhabera/.claude/skills/cissue/SKILL.md && grep -qE 'Depends on: #' /home/talhabera/.claude/skills/cissue/SKILL.md && grep -qE '\[\[cdev\]\]' /home/talhabera/.claude/skills/cissue/SKILL.md && grep -qE 'Draft → confirm|Draft -> confirm|draft' /home/talhabera/.claude/skills/cissue/SKILL.md && echo "CORE-OK"
```
Expected: `CORE-OK` (baseline-gate constraint, dependency marker, [[cdev]] cross-link, and the draft→confirm checkpoint are all present).

- [ ] **Step 6: Commit the spec/plan docs (skill artifact is delivered in place)**

The SKILL.md lives in the non-git personal skills dir (like `cdev`/`cspawn`);
it is delivered and verified in place. Commit the tracked design/plan docs:

```bash
cd /home/talhabera/claude-projects/headless-claude
git add docs/superpowers/specs/2026-05-17-cissue-skill-design.md docs/superpowers/plans/2026-05-17-cissue-skill.md
git commit -m "docs(cissue): spec + implementation plan for the cissue skill"
```
Expected: a commit is created (or "nothing to commit" if the spec was already committed on this branch — in that case `git add` the plan only and commit it).

---

## Task 2: Dry-run the skill against a real scenario

**Files:**
- Reference (read-only): `/home/talhabera/.claude/skills/cissue/SKILL.md`

No code. This task is a structured read-through verifying the skill produces
correct behavior on a representative scenario, catching ambiguity before real
use.

- [ ] **Step 1: Walk the canonical scenario**

Scenario: *"Create 3 issues for the acme project: (a) fix a footer copyright
year, (b) add an FAQ section, (c) wire the FAQ section into the homepage —
(c) depends on (b)."*

Read `SKILL.md` top to bottom and write down, step by step, exactly what an
agent following it would do. The walkthrough MUST yield ALL of:

1. Step 1 preflight: runs `cdev projects`, matches "acme" →
   `talhabera/acme-web`, reads real `repo`/`base_branch`/
   `watch_label`; ensures six labels.
2. Step 3 sizing: (a) and (b) are independent; (c) depends on (b).
3. Step 4: all three drafts shown using the template (Problem/Scope/
   Acceptance criteria checklist/Out of scope/Constraints incl. the
   baseline-gate line), plus a dependency plan stating (c) blocked by (b);
   user confirms before anything is created.
4. Step 5: (a) and (b) created and labeled with the watch label now; (c)
   created UNLABELED with `Depends on: #<b>` in its body.
5. Step 6: report table marks (a),(b) labeled-live and (c) held-blocked
   with the exact `gh issue edit <c> -R talhabera/acme-web
   --add-label <watch>` release line.

- [ ] **Step 2: Record the result and fix any ambiguity inline**

If every one of the 5 expectations is unambiguously produced by the
SKILL.md text → write `DRY-RUN PASS` in your report and stop.

If any expectation is ambiguous or unreachable from the text, edit
`/home/talhabera/.claude/skills/cissue/SKILL.md` to remove the ambiguity
(minimal, targeted wording fix — do not restructure), re-run Task 1 Step 5
verification commands (expect `6` and `CORE-OK`), then re-walk the scenario
until all 5 expectations hold. Report the specific edit(s) made.

- [ ] **Step 3: Commit any SKILL.md-driven doc fixes**

If Step 2 required wording fixes that also imply a spec clarification, update
`docs/superpowers/specs/2026-05-17-cissue-skill-design.md` to match, then:

```bash
cd /home/talhabera/claude-projects/headless-claude
git add docs/superpowers/specs/2026-05-17-cissue-skill-design.md
git commit -m "docs(cissue): clarify spec to match skill wording fix"
```
Expected: a commit, or "nothing to commit" if no spec change was needed.

---

## Self-Review

**1. Spec coverage:**
- Single-file `~/.claude/skills/cissue/SKILL.md`, no code, `[[cdev]]` link → Task 1 Step 3 + Step 5 (`CORE-OK` checks `[[cdev]]`) ✅
- `cdev`/`cspawn` house style (frontmatter, trigger-rich description) → Task 1 Steps 1, 3, 4 ✅
- 6-step workflow (preflight → intake → shape&size → draft→confirm → create&label → report) → Task 1 Step 3 body + Task 2 walkthrough ✅
- Preflight: registered check, real repo/base/watch-label, six labels, unreachable handling → Task 1 Step 3 §1 ✅
- Agent-ready template (Problem/Scope/Acceptance checklist/Out-of-scope/Constraints + mandatory baseline-gate line) → Task 1 Step 3 + Step 5 (`Baseline-relative gate` grep) ✅
- Sizing & decomposition + dependency handling (label only dependency-free, blocked unlabeled with `Depends on: #n`, release one-liner) → Task 1 Step 3 + Step 5 (`Depends on: #` grep) + Task 2 expectations 4–5 ✅
- Safety/edge cases (draft→confirm checkpoint, duplicate guard, collision guard, never merges/edits) → Task 1 Step 3 §Safety ✅
- Skill "done" criteria from spec (frontmatter valid; body covers workflow/template/decomposition/preflight/safety; dry-run scenario) → Task 1 Steps 4–5 + Task 2 ✅

No spec requirement is unmapped.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases" — the full SKILL.md content is provided verbatim in Task 1 Step 3; every verification step has an exact command and expected output. The `<...>` tokens inside the issue *template* are intentional template placeholders the skill fills at runtime (part of the deliverable's content), not plan placeholders.

**3. Type/name consistency:** `name: cissue`, path `/home/talhabera/.claude/skills/cissue/SKILL.md`, the six H2 section titles, the `Baseline-relative gate` / `Depends on: #` / `[[cdev]]` tokens, and the watch-label-only-on-dependency-free rule are referred to identically across Task 1 and Task 2 (the Task 2 expectations quote the same Step-3 section names and behaviors; the Step 5 greps match the literal headings written in Step 3).
