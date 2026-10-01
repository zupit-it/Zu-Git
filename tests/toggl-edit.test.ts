import { test } from "node:test";
import assert from "node:assert/strict";

import { gapAt, moveEdge, moveRow, parseDurationInput, parseTimeInput, type Span } from "../src/toggl-plan.ts";

const m = (clock: string) => {
  const [h, mm] = clock.split(":").map(Number);
  return h * 60 + mm;
};
const span = (id: string, from: string, to: string): Span => ({ id, startMin: m(from), endMin: m(to) });
const DAY = { from: 0, to: 2880 };
const plain = (changes: Map<string, { from: number; to: number }>) =>
  Object.fromEntries([...changes].map(([id, { from, to }]) => [id, [from, to]]));

test("times are read the way people type them", () => {
  assert.equal(parseTimeInput("9", 0), m("9:00"));
  assert.equal(parseTimeInput("930", 0), m("9:30"));
  assert.equal(parseTimeInput("09:30", 0), m("9:30"));
  assert.equal(parseTimeInput("+45m", m("10:00")), m("10:45"));
  assert.equal(parseTimeInput("+1h30", m("10:00")), m("11:30"));
  assert.equal(parseTimeInput("-15", m("10:00")), m("9:45"));
  assert.equal(parseTimeInput("boh", 0), null);
  assert.equal(parseTimeInput("", 0), null);
});

test("durations are read the way people type them", () => {
  assert.equal(parseDurationInput("45"), 45);
  assert.equal(parseDurationInput("45m"), 45);
  assert.equal(parseDurationInput("1h"), 60);
  assert.equal(parseDurationInput("1h30"), 90);
  assert.equal(parseDurationInput("1:15"), 75);
  assert.equal(parseDurationInput("1,5h"), 90);
  assert.equal(parseDurationInput("tanto"), null);
});

test("moving the end of a row moves the boundary with the row after it", () => {
  const rows = [span("a", "08:15", "10:30"), span("b", "10:30", "13:00")];
  assert.deepEqual(plain(moveEdge(rows, [], "a", "end", m("11:00"), 15, DAY)), {
    a: [m("08:15"), m("11:00")],
    b: [m("11:00"), m("13:00")],
  });
});

test("the boundary snaps to the slot and leaves each row at least one slot", () => {
  const rows = [span("a", "08:15", "10:30"), span("b", "10:30", "11:00")];
  const changes = plain(moveEdge(rows, [], "a", "end", m("11:58"), 15, DAY));
  assert.deepEqual(changes, { a: [m("08:15"), m("10:45")], b: [m("10:45"), m("11:00")] });
  assert.deepEqual(plain(moveEdge(rows, [], "a", "end", m("10:38"), 15, DAY)).a, [m("08:15"), m("10:45")]);
});

test("moving the start of a row moves the boundary with the row before it", () => {
  const rows = [span("a", "08:15", "10:30"), span("b", "10:30", "13:00")];
  assert.deepEqual(plain(moveEdge(rows, [], "b", "start", m("10:00"), 15, DAY)), {
    a: [m("08:15"), m("10:00")],
    b: [m("10:00"), m("13:00")],
  });
});

test("detached, or with nothing touching, an edge stops at the next obstacle", () => {
  const rows = [span("a", "08:00", "09:00"), span("b", "09:00", "10:00"), span("c", "11:00", "12:00")];
  const booked = [span("toggl", "12:30", "13:00")];
  // Detached: b stays put, a cannot grow into it.
  assert.deepEqual(plain(moveEdge(rows, booked, "a", "end", m("09:30"), 15, DAY, true)), { a: [m("08:00"), m("09:00")] });
  // b's end is free up to c.
  assert.deepEqual(plain(moveEdge(rows, booked, "b", "end", m("11:30"), 15, DAY)), { b: [m("09:00"), m("11:00")] });
  // c's end stops at the entry already on Toggl.
  assert.deepEqual(plain(moveEdge(rows, booked, "c", "end", m("13:30"), 15, DAY)), { c: [m("11:00"), m("12:30")] });
  // Shrinking detached opens a gap instead of growing the neighbour.
  assert.deepEqual(plain(moveEdge(rows, booked, "a", "end", m("08:30"), 15, DAY, true)), { a: [m("08:00"), m("08:30")] });
});

test("a moved row keeps its length and never slides over a neighbour", () => {
  const rows = [span("a", "08:00", "09:00"), span("b", "10:00", "11:00"), span("c", "12:00", "13:00")];
  assert.deepEqual(moveRow(rows, [], "b", m("10:40"), 15, DAY), { from: m("10:45"), to: m("11:45") });
  assert.deepEqual(moveRow(rows, [], "b", m("11:50"), 15, DAY), { from: m("11:00"), to: m("12:00") });
  assert.deepEqual(moveRow(rows, [], "b", m("07:00"), 15, DAY), { from: m("09:00"), to: m("10:00") });
});

test("a click on free time finds the whole gap around it", () => {
  const spans = [span("a", "08:00", "09:00"), span("toggl", "11:00", "11:30")];
  const range = { from: m("08:00"), to: m("14:00") };
  assert.deepEqual(gapAt(spans, m("10:10"), range, 15), { from: m("09:00"), to: m("11:00") });
  assert.deepEqual(gapAt(spans, m("13:00"), range, 15), { from: m("11:30"), to: m("14:00") });
  assert.equal(gapAt(spans, m("08:30"), range, 15), null, "on a row");
  assert.equal(gapAt(spans, m("15:00"), range, 15), null, "outside the working range");
});
