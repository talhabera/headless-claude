# cissue Skill — Design

**Date:** 2026-05-17
**Status:** Approved (design), pending implementation plan
**Artifact:** a single-file process skill `~/.claude/skills/cissue/SKILL.md`
(sibling to `cdev`/`cspawn`; no code).

## Problem

Creating GitHub issues that the headless-claude/cdev autonomous pipeline can
develop *successfully* is a skill in itself. Ad-hoc issues cause failed runs:
vague scope, no objectively-verifiable acceptance criteria (the independent
review stage checks each item line-by-line), missing "baseline-relative gate"
guardrail (earlier runs bounced trying to chase whole-repo green on
pre-existing failures), unscoped collisions with in-flight PRs, and oversized
multi-concern requests. The user wants a repeatable skill they invoke against
a registered project to mint one or more agent-ready issues.

## Goals

- Turn a single idea OR a batch into well-formed, agent-ready issues.
- Proactively decompose an oversized/multi-concern request into
  dependency-ordered sub-issues up front (better-scoped than the pipeline's
  own auto-decomposer).
- Draft → confirm → create (creating public GitHub issues is outward-facing;
  the confirm step is the safety checkpoint).
- Preflight the project so issues actually drive the pipeline (registered,
  real repo/base/watch-label resolved, all six labels present).

## Non-Goals (YAGNI)

- No code; it is a process skill (like `cdev`/`cspawn`).
- Does not register projects (that is `cdev add`), never merges, never edits
  existing issues' content, only ever applies the watch label (plus creating
  the six labels). Minimal blast radius.
- Does not reimplement the pipeline's internal `issue_deps` model.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Artifact | Single `~/.claude/skills/cissue/SKILL.md`, no code, links `[[cdev]]` |
| Scope | Single or batch; auto-decompose big/multi-concern requests into dependency-ordered sub-issues |
| Interaction | Draft → confirm → create; clarifying questions only when genuinely ambiguous |
| Preflight | Mandatory: registered check + resolve real repo/base/watch-label + ensure six labels |

## Workflow (the skill instructs the agent to do this, in order)

1. **Resolve & preflight the target project.** `cdev projects`; match the
   user's project; read its real `repo`, `base_branch`, `watch_label` (never
   hardcode `claude-dev`/`main`). If not registered → stop, explain, suggest
   `cdev add` (don't file issues against an unwatched repo). Ensure all six
   labels exist (watch + `in-progress`/`pr-open`/`failed`/`decomposed`/
   `merged`); create missing ones idempotently (the documented silent-failure
   trap from `[[cdev]]`). If the service/`cdev` is unreachable → surface it,
   point at `[[cdev]]` recovery; do not create issues blind.
2. **Intake.** Accept one idea or a list. Ask clarifying questions ONLY when
   genuinely ambiguous — not a fixed Q&A.
3. **Shape & size.** Each item → the agent-ready template (below). Split
   anything multi-concern/large into independently-shippable sub-issues.
4. **Draft → confirm.** Show the draft issue(s) + decomposition/dependency
   plan. Nothing is created until the user approves/tweaks.
5. **Create & label.** `gh issue create` each; apply the project's watch
   label to dependency-free issues now; create blocked sub-issues UNLABELED
   with `Depends on: #<n>` in the body. Optionally `cdev poll`.
6. **Report.** Table of number/URL/title, labeled-live vs held-blocked, the
   exact `gh issue edit <n> -R <repo> --add-label <watch>` line to release
   each blocked one once its prerequisite PR merges, whether `cdev poll` ran,
   and the `cdev runs` / `cdev logs <id>` follow-up reminder.

## Agent-ready issue template (the core)

Every filed issue uses exactly this structure:

- **Title** — concise, imperative, scoped.
- **## Problem** — 1–3 concrete sentences: what/why.
- **## Scope** — the exact bounded change; name files/paths/areas when known;
  state the kind of change (i18n-only, copy-only, config-only, component-X-only).
- **## Acceptance criteria** — `- [ ]` checklist of objectively verifiable
  statements. Load-bearing: the independent review stage verifies each item
  against the diff, so each must be unambiguous and testable.
- **## Out of scope** — explicit exclusions, incl. "do not modify <files>"
  when other in-flight issues/PRs touch them.
- **## Constraints** — standard guardrails the pipeline honors: "no behavior
  change" when applicable; **"baseline-relative gate: do not fix unrelated
  pre-existing lint/build failures to chase whole-repo green"** (this exact
  omission bounced earlier runs — it must always be present); any "X-only"
  restriction.

## Sizing & decomposition rules

- Right size = one focused single-concern change a TDD implement→review cycle
  lands cleanly: one area/concern, a small bounded acceptance checklist, no
  "and also".
- Multi-concern/large → split; each sub-issue independently shippable and
  individually template-formed.
- Prefer the lowest-risk slice when a goal can be staged (i18n/content/
  config-only first — these clear the baseline gate cleanly, per history).
- **Dependency handling:** the pipeline's internal `issue_deps` is populated
  only by its OWN auto-decomposer, not by externally-created issues.
  Therefore the skill creates ALL sub-issues, labels only the
  dependency-free ones now, leaves blocked ones UNLABELED with
  `Depends on: #<n>` stated in the body, and reports the release one-liner
  for each. This gives correct ordering without fighting the pipeline model.

## Safety / edge cases

- Draft→confirm is the outward-action checkpoint; nothing filed pre-approval.
- Duplicate guard: scan open issues for a near-identical title; warn instead
  of double-filing.
- Collision guard: when the project has open bot PRs/issues touching the same
  files, add an explicit "Out of scope: do not modify <files>" line
  (the #27-vs-#37 situation).
- Service down / `cdev` unreachable → surface + `[[cdev]]` recovery; no blind
  creation.
- Never merges, never rewrites existing issues, only applies the watch label
  (plus creating the six labels).

## Test / acceptance for the skill itself

Since it is a process skill (no code), "done" =:
- `~/.claude/skills/cissue/SKILL.md` exists with valid frontmatter
  (`name: cissue`, a description listing the trigger phrases) matching the
  `cdev`/`cspawn` house style.
- The body unambiguously instructs the 6-step workflow, the issue template,
  sizing/decomposition + dependency handling, preflight, and safety/edge
  cases above, and links `[[cdev]]`.
- A dry read-through against one real scenario (e.g. "file 3 issues for the
  acme project, one of them depends on another") yields the correct
  behavior: preflight, drafts, decomposition with one held-back blocked
  issue + release one-liner.
