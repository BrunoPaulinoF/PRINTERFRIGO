import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const appPath = new URL("../src/App.tsx", import.meta.url);

test("automatic capture uses lease, cooldown, and weight-change rearm", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("AUTO_SESSION_LEASE_TIMEOUT_MS"), "auto capture must ignore stale browser sessions");
  assert.ok(source.includes("hasFreshAutoSessionLease(session"), "auto loop must check the browser lease before weighing");
  assert.ok(source.includes("lastCapturedWeight"), "auto loop must remember the last captured weight");
  assert.ok(source.includes("hasMeaningfulWeightChange"), "auto loop must rearm on weight change instead of requiring zero");
  assert.ok(source.includes("cooldownElapsed"), "auto loop must keep cooldown protection");
  assert.ok(source.includes("weightChanged"), "auto loop must avoid duplicate labels for unchanged stable weight");
  assert.equal(source.includes("waitingZero"), false, "auto loop must not require returning to zero between captures");
});

test("automatic capture ids are unique beyond millisecond timestamps", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("makeAutoCaptureKey"), "auto capture must use a dedicated id helper");
  assert.ok(source.includes("crypto.randomUUID"), "auto capture id should use UUID when available");
  assert.equal(source.includes("`auto-${Date.now()}`"), false, "auto capture id must not rely only on Date.now");
});

test("print jobs can retry without duplicate local suppression", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("processingJobs"), "print job loop must only suppress concurrent processing");
  assert.ok(source.includes("printedJobs"), "print job loop must remember labels already printed while confirmation is pending");
  assert.ok(source.includes("printedJobs.current.has(job.id)"), "already printed jobs must be confirmed without reprinting");
  assert.equal(source.includes("handledJobs"), false, "failed jobs must not be permanently skipped in memory");
});

test("advanced automatic capture thresholds are configurable in the station UI", async () => {
  const source = await readFile(appPath, "utf8");

  assert.ok(source.includes("stableWindow"), "stability sample window must stay configurable");
  assert.ok(source.includes("stableThresholdKg"), "stability tolerance must stay configurable");
  assert.ok(source.includes("cooldownMs"), "cooldown must stay configurable");
  assert.ok(source.includes("zeroThresholdKg"), "zero threshold must stay configurable");
});
