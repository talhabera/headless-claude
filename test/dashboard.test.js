// test/dashboard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard has a runs section that fetches /runs", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /id="runs"/);
  assert.match(html, /\/runs/);
});
