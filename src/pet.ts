// ── Tiny King: his window ─────────────────────────────────────────────────────
// The page of the small window at the right edge of the screen (pet.html).
// He walks in from beyond the edge, unaware yet; stops, and his face turns to
// the news' mood while his bubble types out what it is about, a page at a time.
// Then he plays it, a few times over, and what comes while he is on. He stays
// a moment, idle, then walks back out in the mood of the last news; once he is
// past the edge the window is closed. The acts are frontal and the walks in
// profile, with nothing drawn between them: a short dissolve joins the two.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  PET_MOODS, checkManifest, isPetPlay, packFrom,
  type PetAnimation, type PetMood, type PetPack, type PetPlay,
} from "./pet-sprites";

declare global {
  interface Window {
    /** Set by the window's initialization script: what to play first, in order. */
    __PET_PLAY?: unknown;
    /** Set with it: a pack loaded in Settings → Fun, its manifest and folder
     *  (ending with a separator); null for the Tiny King built in. */
    __PET_PACK?: { manifest: unknown; dir: string } | null;
  }
}

/** The pack loaded, if it reads right; otherwise the one built in. */
async function loadPack(): Promise<PetPack> {
  const custom = window.__PET_PACK;
  if (custom) {
    try {
      return packFrom(checkManifest(custom.manifest), (file) => convertFileSrc(custom.dir + file));
    } catch {
      // A pack that no longer reads right: the Tiny King comes instead.
    }
  }
  const manifest = checkManifest(await (await fetch("/assets/pet/manifest.json")).json());
  return packFrom(manifest, (file) => `/assets/pet/${file}`);
}

const packReady = loadPack();

/** Longer than any appearance can last within a pack's bounds: past it,
 *  something has gone wrong, and the window closes whatever he is doing. */
const WATCHDOG_MS = 15 * 60_000;
setTimeout(() => void invoke("pet_done"), WATCHDOG_MS);
let pack!: PetPack;

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const bubble = document.querySelector(".bubble") as HTMLElement;
const queue: PetPlay[] = [];
const sheets = new Map<string, Promise<HTMLImageElement | null>>();
/** Canvas px to the right of his resting place: set out of sight as he comes. */
let offset = 0;
let running = false;
/** The frame on the canvas, for a dissolve to start from. */
let shown: { image: HTMLImageElement; frame: number } | null = null;

function sheet(name: string): Promise<HTMLImageElement | null> {
  let loaded = sheets.get(name);
  if (!loaded) {
    // onload rather than decode(), which waits for the page to be drawn: it would
    // never settle in a window the system thinks hidden.
    loaded = packReady.then((ready) => new Promise((resolve) => {
      if (!ready.has(name)) return resolve(null);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = ready.sheetUrl(name);
    }));
    sheets.set(name, loaded);
  }
  return loaded;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cell(image: HTMLImageElement, frame: number) {
  const { cell: { width, height }, columns } = pack;
  ctx.drawImage(
    image,
    (frame % columns) * width, Math.floor(frame / columns) * height, width, height,
    offset, 0, width, height,
  );
}

function draw(image: HTMLImageElement, frame: number) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  cell(image, frame);
  shown = { image, frame };
}

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  shown = null;
}

/** How long a dissolve between a pose in profile and a frontal one takes. */
const DISSOLVE_MS = 160;

/** From the frame shown to `frame` of `name`, the one fading as the other comes. */
async function dissolveTo(name: string, frame: number) {
  const to = await sheet(name);
  if (!to) return;
  const from = shown;
  const start = performance.now();
  for (let t = 0; from && t < 1; t = Math.min(1, (performance.now() - start) / DISSOLVE_MS)) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1 - t;
    cell(from.image, from.frame);
    ctx.globalAlpha = t;
    cell(to, frame);
    ctx.globalAlpha = 1;
    await wait(STEP_MS);
  }
  draw(to, frame);
}

/** Plays a clip where he stands. */
async function playClip(name: string, plays = 1) {
  const image = await sheet(name);
  if (!image) return;
  const { durations } = pack.clips[name];
  for (let play = 0; play < plays; play++) {
    for (let frame = 0; frame < durations.length; frame++) {
      draw(image, frame);
      await wait(durations[frame]);
    }
  }
}

/** Between two steps of a walk. A timer rather than requestAnimationFrame, which
 *  stops for good in a window the system thinks hidden (another Space, a locked
 *  screen): there he still gets where he was going, and his window closes. */
const STEP_MS = 16;

/** Loops a walk while moving him `direction`, a step a frame at its own pace,
 *  until `arrived` holds before a frame. */
async function walk(name: string, direction: -1 | 1, arrived: (frame: number) => boolean) {
  const image = await sheet(name);
  if (!image) return;
  const { durations } = pack.clips[name];
  const frameMs = durations[0];
  const from = offset;
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      const elapsed = Math.max(0, now - start);
      const frame = Math.floor(elapsed / frameMs);
      if (arrived(frame)) return resolve();
      offset = from + (direction * pack.walk.step * elapsed) / frameMs;
      draw(image, frame % durations.length);
      setTimeout(() => tick(performance.now()), STEP_MS);
    };
    tick(start);
  });
}

/** In from beyond the edge, at rest in profile with a neutral face. */
async function enter() {
  // Far enough out to be out of sight, and to stop on the walk's middle frame.
  offset = pack.walk.enterFrames * pack.walk.step;
  await walk("walk_neutral_left", -1, (frame) => frame >= pack.walk.enterFrames);
  // At rest on what would be the walk's frame 4: its stop starts from that frame.
  offset = 0;
  await playClip("walk_stop_neutral_left");
}

/** His face turning to `mood`, still in profile, and held a moment. */
const REACTION_HOLD_MS = 350;
/** His face turning to `mood` on arrival, if the pack has it. */
const reactionOf = (mood: PetMood) => {
  const name = `change_neutral_to_${mood}_left`;
  return mood !== "neutral" && pack.has(name) ? name : null;
};

/** The mood he walks off in: the pack's way out in `mood`, or the neutral one. */
const exitMood = (mood: PetMood): PetMood =>
  pack.has(`walk_start_${mood}`) && pack.has(`walk_${mood}`) ? mood : "neutral";

/** Out past the edge in `mood`: from the frontal pose to the mood's rest pose
 *  in profile, its start, then its walk. */
async function leave(feeling: PetMood) {
  const mood = exitMood(feeling);
  await dissolveTo(`walk_start_${mood}`, 0);
  await playClip(`walk_start_${mood}`);
  await walk(`walk_${mood}`, 1, () => offset >= pack.walk.hidden);
  clear();
}

/** A page stays at least this long: time to read it. */
const PAGE_MIN_MS = 3200;
/** Between two letters of the bubble's title as it is typed out. */
const TYPE_MS = 22;
const BADGES: Record<PetAnimation, string> = { idle: "👑", pr_merged: "🎉", ci_failed: "💥", review_wait: "🔔" };

const part = (name: string) => bubble.querySelector(`.bubble-${name}`) as HTMLElement;
const [badge, body, title, detail, note, pager] = ["badge", "body", "title", "detail", "note", "pager"].map(part);
const bar = bubble.querySelector(".bubble-bar i") as HTMLElement;
/** Bumped by each new bubble: typing and page turns of an older one stop. */
let speech = 0;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** Types `text` into the title. The letters still to come are there already,
 *  transparent, so the bubble has its final size from the start. */
async function typeOut(text: string, turn: number) {
  const letters = Array.from(text);
  const typed = document.createElement("span");
  const rest = document.createElement("span");
  rest.style.color = "transparent";
  title.replaceChildren(typed, rest);
  for (let i = 0; i <= letters.length; i++) {
    if (turn !== speech) return;
    typed.textContent = letters.slice(0, i).join("");
    rest.textContent = letters.slice(i).join("");
    await wait(TYPE_MS);
  }
}

async function showPage(play: PetPlay, index: number, turn: number) {
  if (index > 0) {
    body.classList.add("is-turning");
    await wait(150);
    if (turn !== speech) return;
  }
  const page = play.pages[index];
  bubble.classList.remove("is-typed");
  detail.textContent = page.detail ?? "";
  note.textContent = page.note ?? "";
  pager.textContent = play.pages.length > 1 ? `${index + 1}/${play.pages.length}` : "";
  body.classList.remove("is-turning");
  await typeOut(page.title, turn);
  if (turn === speech) bubble.classList.add("is-typed");
}

/** Shows `play`'s pages for `totalMs`, turning them evenly while the bar empties;
 *  without pages, takes the bubble away. */
function say(play: PetPlay | null, totalMs = 0) {
  const turn = ++speech;
  if (!play?.pages.length) {
    bubble.classList.remove("is-shown");
    return;
  }
  bubble.dataset.tone = play.animation;
  bubble.classList.toggle("is-paged", play.pages.length > 1);
  badge.textContent = BADGES[play.animation];
  // Pops in again for news that follows other news.
  bubble.classList.remove("is-shown");
  void bubble.offsetWidth;
  bubble.classList.add("is-shown");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  void bar.offsetWidth;
  bar.style.transition = `transform ${totalMs}ms linear`;
  bar.style.transform = "scaleX(0)";
  const pageMs = totalMs / play.pages.length;
  play.pages.forEach((_, index) =>
    setTimeout(() => {
      if (turn === speech) void showPage(play, index, turn);
    }, index * pageMs),
  );
}

function play(next: PetPlay) {
  queue.push(next);
  const mood = PET_MOODS[next.animation];
  // Ready by the time he needs them: the act, his face turning, his way out.
  for (const name of [next.animation, `change_neutral_to_${mood}_left`, `walk_start_${mood}`, `walk_${mood}`]) {
    void sheet(name);
  }
  if (!running) void run();
}

async function run() {
  running = true;
  pack = await packReady;
  sizeCanvas();
  await enter();
  const breathMs = sum(pack.clips.idle.durations);
  let mood: PetMood = "neutral";
  for (let next = queue.shift(), first = true; next; next = queue.shift(), first = false) {
    mood = PET_MOODS[next.animation];
    // Only on arrival is he in profile: his face turns, then he faces the front.
    const reaction = first ? reactionOf(mood) : null;
    const arrivalMs = first ? (reaction ? sum(pack.clips[reaction].durations) + REACTION_HOLD_MS : 0) + DISSOLVE_MS : 0;
    const actMs = sum(pack.clips[next.animation].durations) * next.cycles;
    // He stays until every page has been read, whatever comes next; then as
    // long as asked, unless there is more news to play.
    const reading = Math.ceil(Math.max(0, next.pages.length * PAGE_MIN_MS - arrivalMs - actMs) / breathMs);
    const breaths = Math.max(reading, Math.ceil(next.lingerMs / breathMs));
    say(next, arrivalMs + actMs + breaths * breathMs);
    if (reaction) {
      await playClip(reaction);
      await wait(REACTION_HOLD_MS);
    }
    if (first) await dissolveTo(next.animation, 0);
    await playClip(next.animation, next.cycles);
    // Acts end on the neutral pose, which idle starts from.
    for (let breath = 0; breath < breaths && (breath < reading || !queue.length); breath++) await playClip("idle");
  }
  say(null);
  await leave(mood);
  // Called again while he was walking out: back in he comes.
  if (queue.length) return void run();
  running = false;
  await invoke("pet_done");
}

/** The canvas at the pack's cell size, shown as tall as the window allows him. */
function sizeCanvas() {
  canvas.width = pack.cell.width;
  canvas.height = pack.cell.height;
  canvas.style.width = `${Math.round((KING_HEIGHT_PX * pack.cell.width) / pack.cell.height)}px`;
}
/** His height on screen, in CSS px (pet.html, pet.rs). */
const KING_HEIGHT_PX = 184;

for (const name of ["walk_neutral_left", "walk_stop_neutral_left", "idle"]) void sheet(name);
/** Queues every valid play in `plays`, in order; true if there was one. */
function playAll(plays: unknown): boolean {
  const valid = (Array.isArray(plays) ? plays : [plays]).filter(isPetPlay);
  valid.forEach(play);
  return valid.length > 0;
}

void listen<unknown>("pet-play", (event) => void playAll(event.payload));
// Opened without being told what to play (a browser, say): a plain visit.
if (!playAll(window.__PET_PLAY)) play({ animation: "idle", pages: [], cycles: 1, lingerMs: 0 });
