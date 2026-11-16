import { test } from "node:test";
import assert from "node:assert/strict";
import { isSilentAt, silentWindowLabel, type SilentWindow } from "../src/silent-mode.ts";

/** A local time of day, on a Tuesday. */
const at = (hour: number, minute = 0, second = 0) => new Date(2026, 10, 17, hour, minute, second);
const night: SilentWindow = { enabled: true, from: "14:00", to: "08:00" };
const lunch: SilentWindow = { enabled: true, from: "12:30", to: "14:00" };

test("a window crossing midnight is silent from its start until its end the next day", () => {
  assert.equal(isSilentAt(night, at(13, 59, 59)), false);
  assert.equal(isSilentAt(night, at(15)), true);
  assert.equal(isSilentAt(night, at(23, 59)), true);
  assert.equal(isSilentAt(night, at(0)), true);
  assert.equal(isSilentAt(night, at(7, 59, 59)), true);
  assert.equal(isSilentAt(night, at(10)), false);
});

test("the start is in the window, the end is out", () => {
  assert.equal(isSilentAt(night, at(14)), true);
  assert.equal(isSilentAt(night, at(8)), false);
  assert.equal(isSilentAt(lunch, at(12, 30)), true);
  assert.equal(isSilentAt(lunch, at(14)), false);
});

test("a same-day window is silent only between its two times", () => {
  assert.equal(isSilentAt(lunch, at(12, 29)), false);
  assert.equal(isSilentAt(lunch, at(13)), true);
  assert.equal(isSilentAt(lunch, at(13, 59)), true);
  assert.equal(isSilentAt(lunch, at(20)), false);
  assert.equal(isSilentAt(lunch, at(3)), false);
});

test("switched off, nothing is silent whatever the times", () => {
  for (const hour of [0, 8, 14, 20]) {
    assert.equal(isSilentAt({ ...night, enabled: false }, at(hour)), false);
    assert.equal(isSilentAt({ enabled: false, from: "09:00", to: "09:00" }, at(hour)), false);
  }
});

test("the same time twice is the whole day", () => {
  const always: SilentWindow = { enabled: true, from: "09:00", to: "09:00" };
  for (const [hour, minute] of [[0, 0], [8, 59], [9, 0], [9, 1], [23, 59]]) {
    assert.equal(isSilentAt(always, at(hour!, minute)), true);
  }
});

test("midnight as a bound", () => {
  const evening: SilentWindow = { enabled: true, from: "18:00", to: "00:00" };
  assert.equal(isSilentAt(evening, at(17, 59)), false);
  assert.equal(isSilentAt(evening, at(23, 59)), true);
  assert.equal(isSilentAt(evening, at(0)), false);
  const earlyHours: SilentWindow = { enabled: true, from: "00:00", to: "08:00" };
  assert.equal(isSilentAt(earlyHours, at(0)), true);
  assert.equal(isSilentAt(earlyHours, at(8)), false);
});

test("a time that cannot be read silences nothing", () => {
  assert.equal(isSilentAt({ enabled: true, from: "", to: "08:00" }, at(3)), false);
  assert.equal(isSilentAt({ enabled: true, from: "25:00", to: "08:00" }, at(3)), false);
});

test("the window says itself as its two times, or as the whole day", () => {
  assert.equal(silentWindowLabel(night), "14:00 → 08:00");
  assert.equal(silentWindowLabel({ from: "09:00", to: "09:00" }), "All day");
});
