// test/stage-prompt-hardening.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpecPlanPrompt } from "../src/stages/specPlan.js";
import { buildImplementPrompt } from "../src/stages/implement.js";
import { buildReviewPrompt } from "../src/stages/review.js";
import { buildResolvePrompt } from "../src/stages/resolveConflict.js";

// ---------------------------------------------------------------------------
// buildSpecPlanPrompt
// ---------------------------------------------------------------------------
test("buildSpecPlanPrompt contains prohibition block phrases", () => {
  const prompt = buildSpecPlanPrompt({ number: 1, title: "t", body: "b" });
  assert.ok(prompt.includes("DO NOT run `gh`"), "must contain: DO NOT run `gh`");
  assert.ok(prompt.includes("git push"), "must contain: git push");
  assert.ok(prompt.includes("automated orchestrator"), "must contain: automated orchestrator");
});

test("buildSpecPlanPrompt instructs capturing issue conventions into checklist", () => {
  const prompt = buildSpecPlanPrompt({ number: 1, title: "t", body: "b" });
  assert.ok(
    prompt.toLowerCase().includes("convention"),
    "must mention convention(s)",
  );
  assert.ok(
    prompt.includes("acceptanceChecklist") || prompt.includes("checklist"),
    "must reference acceptanceChecklist or checklist in context of capturing conventions",
  );
});

// ---------------------------------------------------------------------------
// buildImplementPrompt
// ---------------------------------------------------------------------------
test("buildImplementPrompt contains prohibition block phrases", () => {
  const prompt = buildImplementPrompt("plan");
  assert.ok(prompt.includes("DO NOT run `gh`"), "must contain: DO NOT run `gh`");
  assert.ok(prompt.includes("git push"), "must contain: git push");
  assert.ok(prompt.includes("automated orchestrator"), "must contain: automated orchestrator");
});

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------
test("buildReviewPrompt contains prohibition block phrases", () => {
  const prompt = buildReviewPrompt("spec", '["x"]');
  assert.ok(prompt.includes("DO NOT run `gh`"), "must contain: DO NOT run `gh`");
  assert.ok(prompt.includes("git push"), "must contain: git push");
  assert.ok(prompt.includes("automated orchestrator"), "must contain: automated orchestrator");
});

test("buildReviewPrompt enforces per-item acceptance criteria + conventions + changes-requested", () => {
  const prompt = buildReviewPrompt("spec", '["x"]');
  assert.ok(
    prompt.toLowerCase().includes("acceptance"),
    "must reference acceptance criteria enforcement",
  );
  assert.ok(
    prompt.toLowerCase().includes("convention"),
    "must reference convention enforcement",
  );
  assert.ok(
    prompt.includes("changes-requested"),
    "must state changes-requested as mandatory verdict when items unmet",
  );
});

// ---------------------------------------------------------------------------
// buildResolvePrompt
// ---------------------------------------------------------------------------
test("buildResolvePrompt contains prohibition block phrases", () => {
  const prompt = buildResolvePrompt(["a.js"]);
  assert.ok(prompt.includes("DO NOT run `gh`"), "must contain: DO NOT run `gh`");
  assert.ok(prompt.includes("git push"), "must contain: git push");
  assert.ok(prompt.includes("automated orchestrator"), "must contain: automated orchestrator");
});
