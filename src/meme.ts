// ── Meme mode ─────────────────────────────────────────────────────────────────
// Settings → Fun. It sets `data-meme` on the page; what it changes looks for it.

export function memeMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-meme");
}

// ── The sad reviewer ──────────────────────────────────────────────────────────
// Peeking over the top edge of a comment being written in the diff, a face
// whose eyes follow the caret. The picture shows as the box's background
// straight away; once an editor is in use, a canvas over it redraws the picture
// with each eye's pixels pulled towards the caret — the eyes themselves move,
// nothing is pasted.

const EDITOR = "textarea[data-pd-edit]";
const PICTURE = "/assets/meme/sad-reviewer.png";
const SIZE = 320;
/** Measured on the picture (320 × 320): each eyeball's centre and radii. */
const EYES = [
  { x: 115.5, y: 124.5, rx: 22, ry: 15 },
  { x: 187.5, y: 149.5, rx: 22, ry: 15 },
];
/** Already looking a little down and away. */
const REST = { x: 0, y: -1.5 };

/** The face for a comment editor (comment-box.ts), or nothing outside meme mode. */
export function sadReviewer(): string {
  if (!memeMode()) return "";
  return `<div class="pd-meme" aria-hidden="true" title="Sta leggendo il tuo commento…">` +
    `<canvas width="${SIZE}" height="${SIZE}"></canvas>` +
    `</div>`;
}

let source: ImageData | null = null;
let loading: Promise<void> | null = null;

/** The picture's pixels, read once. */
function loadPicture(): Promise<void> {
  loading ??= new Promise((resolve) => {
    const picture = new Image();
    picture.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(picture, 0, 0, SIZE, SIZE);
        source = ctx.getImageData(0, 0, SIZE, SIZE);
      }
      resolve();
    };
    picture.onerror = () => resolve();
    picture.src = PICTURE;
  });
  return loading;
}

interface Face {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  frame: ImageData;
  at: { x: number; y: number };
  to: { x: number; y: number };
  moving: boolean;
}

const faces = new WeakMap<HTMLCanvasElement, Face>();

function faceFor(canvas: HTMLCanvasElement): Face | null {
  const known = faces.get(canvas);
  if (known) return known;
  const ctx = canvas.getContext("2d");
  if (!source || !ctx) return null;
  const face = { canvas, ctx, frame: ctx.createImageData(SIZE, SIZE), at: { ...REST }, to: { ...REST }, moving: false };
  faces.set(canvas, face);
  return face;
}

/** The picture, each eyeball's pixels shifted by the gaze — most in the middle, none at the rim. */
function draw(face: Face) {
  if (!source) return;
  const { data } = face.frame;
  data.set(source.data);
  for (const eye of EYES) {
    const minX = Math.max(0, Math.floor(eye.x - eye.rx)), maxX = Math.min(SIZE - 1, Math.ceil(eye.x + eye.rx));
    const minY = Math.max(0, Math.floor(eye.y - eye.ry)), maxY = Math.min(SIZE - 1, Math.ceil(eye.y + eye.ry));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const nx = (x - eye.x) / eye.rx, ny = (y - eye.y) / eye.ry;
        const r2 = nx * nx + ny * ny;
        if (r2 >= 1) continue;
        const falloff = (1 - r2) ** 2;
        const sx = Math.max(0, Math.min(SIZE - 1, Math.round(x - face.at.x * falloff)));
        const sy = Math.max(0, Math.min(SIZE - 1, Math.round(y - face.at.y * falloff)));
        const to = (y * SIZE + x) * 4, from = (sy * SIZE + sx) * 4;
        data[to] = source.data[from];
        data[to + 1] = source.data[from + 1];
        data[to + 2] = source.data[from + 2];
        data[to + 3] = source.data[from + 3];
      }
    }
  }
  face.ctx.putImageData(face.frame, 0, 0);
}

/** Eases towards where it should look, a frame at a time, and stops once there. */
function step(face: Face) {
  if (!face.canvas.isConnected) {
    face.moving = false;
    return;
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = reduced ? 1 : 0.09;
  face.at.x += (face.to.x - face.at.x) * ease;
  face.at.y += (face.to.y - face.at.y) * ease;
  const there = Math.abs(face.to.x - face.at.x) < 0.02 && Math.abs(face.to.y - face.at.y) < 0.02;
  if (there) face.at = { ...face.to };
  draw(face);
  face.moving = !there;
  if (face.moving) requestAnimationFrame(() => step(face));
}

function look(canvas: HTMLCanvasElement, gaze: { x: number; y: number }) {
  const face = faceFor(canvas);
  if (!face) return;
  face.to = gaze;
  if (!face.moving) {
    face.moving = true;
    requestAnimationFrame(() => step(face));
  }
}

/** Where the caret is on screen: a hidden copy of the textarea, laid out the same, up to it. */
function caretPoint(textarea: HTMLTextAreaElement): { x: number; y: number } {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "tabSize",
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", top: "0", left: "-9999px",
    whiteSpace: "pre-wrap", overflowWrap: "break-word", borderStyle: "solid",
  });
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart ?? 0);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const x = marker.offsetLeft;
  const y = marker.offsetTop;
  mirror.remove();
  const box = textarea.getBoundingClientRect();
  return { x: box.left + x - textarea.scrollLeft, y: box.top + y - textarea.scrollTop };
}

function canvasOf(textarea: HTMLTextAreaElement): HTMLCanvasElement | null {
  return textarea.closest(".pd-cbox")?.querySelector<HTMLCanvasElement>(".pd-meme canvas") ?? null;
}

function follow(textarea: HTMLTextAreaElement) {
  const canvas = canvasOf(textarea);
  if (!canvas) return;
  if (!source) {
    void loadPicture().then(() => follow(textarea));
    return;
  }
  const caret = caretPoint(textarea);
  const box = canvas.getBoundingClientRect();
  // From between the eyes; the picture's pixels move at most a few.
  const dx = caret.x - (box.left + box.width * 0.5);
  const dy = caret.y - (box.top + box.height * 0.39);
  look(canvas, {
    x: Math.max(-2.8, Math.min(2.8, dx / 115)),
    y: Math.max(-2.4, Math.min(2.2, dy / 170 - 1.35)),
  });
}

function editorOf(target: EventTarget | null): HTMLTextAreaElement | null {
  return target instanceof HTMLTextAreaElement && target.matches(EDITOR) ? target : null;
}

let installed = false;

/** Once, at start: the eyes follow whichever comment editor is being written in. */
export function installSadReviewer() {
  if (installed) return;
  installed = true;
  const onEditor = (event: Event) => {
    const textarea = editorOf(event.target);
    if (textarea) requestAnimationFrame(() => follow(textarea));
  };
  for (const type of ["focusin", "input", "keyup", "click"]) document.addEventListener(type, onEditor);
  document.addEventListener("selectionchange", () => {
    const textarea = editorOf(document.activeElement);
    if (textarea) follow(textarea);
  });
  document.addEventListener("focusout", (event) => {
    const textarea = editorOf(event.target);
    const canvas = textarea && canvasOf(textarea);
    if (canvas) look(canvas, REST);
  });
}
