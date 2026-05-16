// test/config-preview.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("previewDeployTimeoutMs and previewPollMs default correctly", () => {
  const c = loadConfig({});
  assert.equal(c.previewDeployTimeoutMs, 600000);
  assert.equal(c.previewPollMs, 10000);
});

test("previewDeployTimeoutMs and previewPollMs parse from env overrides", () => {
  const c = loadConfig({
    PREVIEW_DEPLOY_TIMEOUT_MS: "1000",
    PREVIEW_POLL_MS: "250",
  });
  assert.equal(c.previewDeployTimeoutMs, 1000);
  assert.equal(c.previewPollMs, 250);
});
