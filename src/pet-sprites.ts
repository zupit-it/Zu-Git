// ── Tiny King: the character pack ─────────────────────────────────────────────
// Who walks on screen comes from a pack: a manifest.json naming each clip's
// sheet and frame lengths, and the PNG sheets, their cells read left to right
// then top to bottom. The Tiny King is the pack built in (public/assets/pet);
// one loaded in Settings → Fun takes his place (pet_pack.rs checks it on the
// way in, the window reads it). The clips:
//   idle, pr_merged, ci_failed, review_wait — the acts, each starting and
//     ending on the same frontal pose, so one can follow another;
//   walk_neutral_left, walk_stop_neutral_left — in from the right: the stop
//     starts on the walk's middle frame (a contact) and ends at rest;
//   walk_start_neutral, walk_neutral — out to the right: the start ends on the
//     frame before the walk's first.
// Optional, per mood (angry, impatient, happy): walk_start_<mood> and
// walk_<mood> to walk off in it, change_neutral_to_<mood>_left for his face
// on arrival. Without them he stays neutral. Profile and front are joined by
// a short dissolve, so their poses need not match.

import type { PetPage } from "./pet-lines";

/** What the king can be called out for. */
export type PetAnimation = "idle" | "pr_merged" | "ci_failed" | "review_wait";
export type PetMood = "neutral" | "angry" | "impatient" | "happy";

/** The mood each act is played in. */
export const PET_MOODS: Record<PetAnimation, PetMood> = {
  idle: "neutral",
  pr_merged: "happy",
  ci_failed: "angry",
  review_wait: "impatient",
};

export const REQUIRED_CLIPS = [
  "idle", "pr_merged", "ci_failed", "review_wait",
  "walk_neutral_left", "walk_stop_neutral_left", "walk_start_neutral", "walk_neutral",
] as const;

/** Bounds a pack must keep to (pet_pack.rs checks the same on import): none
 *  can make him huge, slow to the point of never leaving, or reach a file
 *  outside the pack. */
export const PACK_LIMITS = {
  cell: [16, 1024],
  columns: [1, 32],
  clips: 64,
  frames: 64,
  frameMs: [10, 2_000],
  clipMs: 8_000,
  walkFrameMs: 250,
  /** walk.step and walk.hidden, as shares of the cell's width. */
  stepShare: [1 / 96, 1],
  hiddenShare: [0, 1.5],
  name: 60,
} as const;

export interface PetClip {
  /** The sheet's file name in the pack, a PNG. */
  sheet: string;
  /** How long each frame stays, in ms; one entry per frame. */
  durations: number[];
}

export interface PetManifest {
  format: "zugit-pet";
  version: 1;
  name: string;
  cell: { width: number; height: number };
  columns: number;
  /** Canvas px a walking frame (the planted foot's slide, so it stays put), and
   *  px to the right of his resting place where no part of him shows. Both
   *  have defaults from the cell's width. */
  walk?: { step?: number; hidden?: number };
  clips: Record<string, PetClip>;
}

const SHEET = /^[\w-][\w.-]{0,59}\.png$/i;
const CLIP = /^[a-z0-9_]{1,48}$/;
/** Names Windows keeps for devices, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const isInt = (v: unknown, [min, max]: readonly [number, number]) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** `value` as a manifest, or an error saying what is wrong with it. */
export function checkManifest(value: unknown): PetManifest {
  const m = value as Partial<PetManifest> | null;
  const fail = (why: string): never => { throw new Error(`Character pack: ${why}.`); };
  if (!m || typeof m !== "object") fail("manifest.json is not an object");
  if (m?.format !== "zugit-pet" || m.version !== 1) fail(`not a ZuGit pack (format "zugit-pet", version 1)`);
  if (typeof m?.name !== "string" || !m.name.trim() || m.name.length > PACK_LIMITS.name || /[\u0000-\u001f\u007f]/.test(m.name)) {
    fail("it needs a name, 60 characters at most");
  }
  if (!isInt(m?.cell?.width, PACK_LIMITS.cell) || !isInt(m?.cell?.height, PACK_LIMITS.cell)) fail("cell width and height must be whole px, 16 to 1024");
  if (!isInt(m?.columns, PACK_LIMITS.columns)) fail("columns must be 1 to 32");
  const clips = m?.clips;
  if (!clips || typeof clips !== "object" || Object.keys(clips).length > PACK_LIMITS.clips) fail("clips must be an object of 64 clips at most");
  for (const [name, clip] of Object.entries(clips ?? {})) {
    if (!CLIP.test(name)) fail("clip names are lowercase letters, digits and _, 48 at most");
    if (typeof clip?.sheet !== "string" || !SHEET.test(clip.sheet) || RESERVED.test(clip.sheet)) {
      fail(`${name}: sheet must be a plain .png file name`);
    }
    const d = clip.durations;
    const frameMs: readonly [number, number] = name.startsWith("walk_") ? [PACK_LIMITS.frameMs[0], PACK_LIMITS.walkFrameMs] : PACK_LIMITS.frameMs;
    if (!Array.isArray(d) || !d.length || d.length > PACK_LIMITS.frames || !d.every((ms) => isInt(ms, frameMs))) {
      fail(`${name}: durations must be 1 to 64 frames of ${frameMs[0]} to ${frameMs[1]} ms`);
    }
    if (d.reduce((total, ms) => total + ms, 0) > PACK_LIMITS.clipMs) fail(`${name}: a clip lasts 8 s at most`);
  }
  for (const name of REQUIRED_CLIPS) if (!clips?.[name]) fail(`clip ${name} is missing`);
  const walk = m?.walk;
  const width = m?.cell?.width ?? 0;
  const within = (v: unknown, [lo, hi]: readonly [number, number]) =>
    v === undefined || (typeof v === "number" && v >= lo * width && v > 0 && v <= hi * width);
  if (walk !== undefined && (typeof walk !== "object" || walk === null ||
      !within(walk.step, PACK_LIMITS.stepShare) || !within(walk.hidden, PACK_LIMITS.hiddenShare))) {
    fail("walk.step and walk.hidden are out of bounds for this cell");
  }
  return m as PetManifest;
}

/** A pack ready to play: its manifest, where its sheets are, its walk's measures. */
export interface PetPack {
  name: string;
  cell: { width: number; height: number };
  columns: number;
  clips: Record<string, PetClip>;
  has(name: string): boolean;
  sheetUrl(name: string): string;
  walk: {
    step: number;
    hidden: number;
    /** Walking frames on the way in: enough to come from out of sight, and
     *  ending on the walk's middle frame, where its stop takes over. */
    enterFrames: number;
  };
}

export function packFrom(manifest: PetManifest, url: (sheet: string) => string): PetPack {
  const { cell, columns, clips } = manifest;
  const step = manifest.walk?.step ?? cell.width / 48;
  const hidden = manifest.walk?.hidden ?? cell.width;
  const cycle = clips.walk_neutral_left.durations.length;
  const contact = Math.floor(cycle / 2);
  const least = Math.ceil(hidden / step);
  const enterFrames = least + (((contact - least) % cycle) + cycle) % cycle;
  return {
    name: manifest.name,
    cell,
    columns,
    clips,
    has: (name) => Object.prototype.hasOwnProperty.call(clips, name),
    sheetUrl: (name) => url(clips[name].sheet),
    walk: { step, hidden, enterFrames },
  };
}

/** One appearance: sent by the main window, played by the king's (pet_play). */
export interface PetPlay {
  animation: PetAnimation;
  /** What his bubble says, a page at a time; no pages, no bubble. */
  pages: PetPage[];
  /** Times the animation plays in a row (Settings → Fun). */
  cycles: number;
  /** How long he stays, idle, before walking off. */
  lingerMs: number;
}

const ANIMATIONS: readonly string[] = ["idle", "pr_merged", "ci_failed", "review_wait"];

export function isPetAnimation(name: unknown): name is PetAnimation {
  return typeof name === "string" && ANIMATIONS.includes(name);
}

export function isPetPlay(play: unknown): play is PetPlay {
  return typeof play === "object" && play !== null && isPetAnimation((play as PetPlay).animation);
}
