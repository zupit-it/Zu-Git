import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { REQUIRED_CLIPS, checkManifest, packFrom, type PetManifest } from "../src/pet-sprites.ts";

const builtIn = JSON.parse(readFileSync(new URL("../public/assets/pet/manifest.json", import.meta.url), "utf8"));

function manifest(extra: Partial<PetManifest> = {}): PetManifest {
  const clips = Object.fromEntries(REQUIRED_CLIPS.map((c) => [c, { sheet: `${c}.png`, durations: [100, 100, 100, 100, 100, 100, 100, 100] }]));
  return { format: "zugit-pet", version: 1, name: "Pixel", cell: { width: 96, height: 128 }, columns: 4, clips, ...extra };
}

test("the Tiny King's own pack reads right, with the measures he walks by", () => {
  const pack = packFrom(checkManifest(builtIn), (file) => `/assets/pet/${file}`);
  assert.equal(pack.name, "Tiny King");
  assert.deepEqual(pack.walk, { step: 6, hidden: 264, enterFrames: 44 });
  assert.equal(pack.sheetUrl("walk_happy"), "/assets/pet/walk_happy.webp");
  assert.ok(pack.has("change_neutral_to_angry_left"));
  assert.ok(!pack.has("toString"));
});

test("without walk measures, they come from the cell, ending on the walk's middle frame", () => {
  // step 96/48 = 2 px, out of sight at 96 px: 48 frames, already 0 mod 8 → 52 to land on frame 4.
  const { walk } = packFrom(checkManifest(manifest()), (f) => f);
  assert.deepEqual(walk, { step: 2, hidden: 96, enterFrames: 52 });
  assert.equal(walk.enterFrames % 8, 4);
  assert.ok(walk.enterFrames * walk.step >= walk.hidden);
});

test("a manifest is refused for what is wrong with it", () => {
  const wrong = (m: unknown) => assert.throws(() => checkManifest(m));
  wrong(null);
  wrong({ ...manifest(), format: "other" });
  wrong({ ...manifest(), name: " " });
  wrong({ ...manifest(), cell: { width: 8, height: 128 } });
  wrong({ ...manifest(), columns: 0 });
  wrong({ ...manifest(), walk: { step: -1 } });
  const missing = manifest();
  delete missing.clips.review_wait;
  assert.throws(() => checkManifest(missing), /review_wait is missing/);
  const escape = manifest();
  escape.clips.idle = { sheet: "../evil.png", durations: [100] };
  assert.throws(() => checkManifest(escape), /idle: sheet/);
  const slow = manifest();
  slow.clips.idle = { sheet: "idle.png", durations: [0] };
  assert.throws(() => checkManifest(slow), /durations/);
});

test("a pack cannot keep him on screen for ever, nor name a device", () => {
  const throwsFor = (edit: (m: PetManifest) => void, why: RegExp) => {
    const m = manifest();
    edit(m);
    assert.throws(() => checkManifest(m), why);
  };
  throwsFor((m) => { m.clips.idle = { sheet: "idle.png", durations: [5000] }; }, /idle: durations/);
  throwsFor((m) => { m.clips.idle = { sheet: "idle.png", durations: [2000, 2000, 2000, 2000, 2000] }; }, /8 s at most/);
  throwsFor((m) => { m.clips.walk_neutral_left = { sheet: "w.png", durations: [600] }; }, /walk_neutral_left: durations/);
  throwsFor((m) => { m.walk = { step: 0.01 }; }, /out of bounds/);
  throwsFor((m) => { m.walk = { hidden: 10_000 }; }, /out of bounds/);
  throwsFor((m) => { m.clips.idle = { sheet: "CON.png", durations: [100] }; }, /idle: sheet/);
  throwsFor((m) => { m.clips.idle = { sheet: "idle.gif", durations: [100] }; }, /idle: sheet/);
  throwsFor((m) => { m.clips.IDLE = { sheet: "x.png", durations: [100] }; }, /clip names/);
  const fine = manifest();
  fine.walk = { step: 1, hidden: 90 };
  assert.doesNotThrow(() => checkManifest(fine));
});
