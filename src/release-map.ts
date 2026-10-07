import { escHtml } from "./utils";
import type { Lane, MapItem, MapLayout, Station, StationKind, TagMark } from "./release-map-layout";

// Renders a MapLayout as the metro map above the release diff list. Geometry
// lives here; which story goes where is decided in release-map-layout.ts.

const PAD_X = 24;
const STATION_R = 6.5;
const LANE_GAP = 104;
const FLAG_ROW = 24;
const LABEL_CHAR_W = 6.3;

interface Geometry {
  col: number;
  mainY: number;
  branchY: number;
  flagRows: number;
  width: number;
  height: number;
  x: (col: number) => number;
  y: (lane: Lane) => number;
}

/** Tags longer than a column show their last segment: "v1.79.0-beta.3" → "beta.3". */
function shortTag(name: string): string {
  if (name.length <= 10) return name;
  const dash = name.lastIndexOf("-");
  return dash > 0 ? name.slice(dash + 1) : name;
}

function pillWidth(text: string): number {
  return Math.round(text.length * LABEL_CHAR_W + 18);
}

/** Flag tags on main stack into rows so neighbouring tags never overlap. */
function assignFlagRows(tags: TagMark[], x: (col: number) => number): Map<TagMark, number> {
  const rows: number[] = [];
  const out = new Map<TagMark, number>();
  const flags = tags.filter(t => t.style === "flag").sort((a, b) => a.col - b.col);
  for (const tag of flags) {
    const w = pillWidth(shortTag(tag.name));
    const left = x(tag.col) - w / 2;
    let row = rows.findIndex(right => left > right + 6);
    if (row === -1) { row = rows.length; rows.push(0); }
    rows[row] = left + w;
    out.set(tag, row);
  }
  return out;
}

function geometry(layout: MapLayout): Geometry & { flagRow: Map<TagMark, number> } {
  const longest = Math.max(6, ...layout.stations.map(s => s.label.length));
  const col = Math.min(104, Math.max(70, Math.ceil(longest * LABEL_CHAR_W + 16)));
  // Branch mode keeps a column of room on the left for the fork to curve in.
  const left = layout.mode === "branch" ? PAD_X + col : PAD_X;
  const x = (c: number) => left + c * col + col / 2;
  const flagRow = assignFlagRows(layout.tags, x);
  const flagRows = flagRow.size > 0 ? Math.max(...flagRow.values()) + 1 : 0;
  const mainY = 46 + flagRows * FLAG_ROW;
  const branchY = mainY + LANE_GAP;
  const bottom = layout.mode === "branch" ? branchY : mainY;
  return {
    col, mainY, branchY, flagRows, flagRow,
    width: left + PAD_X + layout.cols * col,
    height: bottom + 38,
    x,
    y: lane => (lane === "main" ? mainY : branchY),
  };
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function keysAttr(keys: string[]): string {
  return escHtml(keys.join(" "));
}

function renderLines(layout: MapLayout, g: Geometry): string {
  const out: string[] = [];
  const { x, mainY, branchY } = g;

  // Branch mode: main comes from further back in history, so it runs in from the edge.
  const mainFrom = layout.mode === "branch" ? 0 : x(0);
  out.push(`<path class="rm-line rm-line--main" d="M${mainFrom} ${mainY}H${x(layout.main.head)}"/>`);
  if (layout.main.to > layout.main.head) {
    out.push(`<path class="rm-line rm-line--main rm-line--ahead" d="M${x(layout.main.head)} ${mainY}H${x(layout.main.to)}"/>`);
  }

  if (layout.branch) {
    const x0 = x(0);
    const forkX = x0 - g.col * 1.4;
    const fork = `M${forkX} ${mainY}C${forkX + g.col * 0.7} ${mainY} ${x0 - g.col * 0.7} ${branchY} ${x0} ${branchY}`;
    out.push(`<path class="rm-line rm-line--branch" d="${fork}H${x(layout.branch.head)}"/>`);
    if (layout.branch.to > layout.branch.head) {
      out.push(`<path class="rm-line rm-line--branch rm-line--ahead" d="M${x(layout.branch.head)} ${branchY}H${x(layout.branch.to)}"/>`);
    }
  }
  return out.join("");
}

function isDimmed(keys: string[], visible: Set<string> | null): boolean {
  return visible !== null && !keys.some(k => visible.has(k));
}

function renderLinks(layout: MapLayout, g: Geometry, visible: Set<string> | null): string {
  const top = g.mainY + STATION_R + 4;
  const bottom = g.branchY - STATION_R - 4;
  return layout.links.map(link => {
    const x = g.x(link.col);
    const dim = isDimmed(link.keys, visible) ? " rm-dim" : "";
    return `<path class="rm-link rm-link--${link.kind}${dim}" data-rm-keys="${keysAttr(link.keys)}" d="M${x} ${top}V${bottom}"/>`;
  }).join("");
}

function stationShape(kind: StationKind, ghost: boolean, x: number, y: number): string {
  const r = STATION_R;
  if (kind === "extra") {
    const d = r + 1.5;
    return `<path class="rm-halo" d="M${x} ${y - d - 3}L${x + d + 3} ${y}L${x} ${y + d + 3}L${x - d - 3} ${y}Z"/>
      <path class="rm-shape" d="M${x} ${y - d}L${x + d} ${y}L${x} ${y + d}L${x - d} ${y}Z"/>`;
  }
  return `<circle class="rm-halo" cx="${x}" cy="${y}" r="${r + 3}"/>
    <circle class="rm-shape${ghost ? " rm-shape--ghost" : ""}" cx="${x}" cy="${y}" r="${ghost ? r - 0.5 : r}"/>`;
}

/** A rounded label on the line; `base` names the classes, `variant` adds a modifier to both. */
function renderPill(x: number, y: number, text: string, base: string, variant = ""): string {
  const w = pillWidth(text);
  const mod = (cls: string) => (variant ? `${cls} ${cls}--${variant}` : cls);
  return `<rect class="${mod(base)}" x="${x - w / 2}" y="${y - 9}" width="${w}" height="18" rx="9"/>
    <text class="${mod(`${base}-text`)}" x="${x}" y="${y + 3.5}" text-anchor="middle">${escHtml(text)}</text>`;
}

function renderStation(st: Station, layout: MapLayout, g: Geometry): string {
  const x = g.x(st.col);
  const y = g.y(st.lane);
  const attrs = `data-rm-id="${escHtml(st.id)}" data-rm-keys="${keysAttr(st.keys)}"`;

  if (st.kind === "cluster" || st.kind === "earlier") {
    return `<g class="rm-st rm-st--${st.kind}" ${attrs}>${renderPill(x, y, `+${st.count ?? 0}`, "rm-pill")}</g>`;
  }

  // Keys sit above main and below the branch; on the branch, a stop that
  // mirrors one on main only repeats its key softly.
  const mirrored = st.lane === "branch" && layout.stations.some(o => o.lane === "main" && o.col === st.col);
  const labelY = st.lane === "main" ? y - 16 : y + 24;
  const label = st.label
    ? `<text class="rm-label${mirrored ? " rm-label--soft" : ""}" x="${x}" y="${labelY}" text-anchor="middle">${escHtml(st.label)}</text>`
    : "";
  const subY = st.lane === "main" ? y + 24 : y + 38;
  const sub = st.sub
    ? `<text class="rm-sub${st.sub === "no PR" ? " rm-sub--none" : ""}" x="${x}" y="${subY}" text-anchor="middle">${escHtml(st.sub)}</text>`
    : st.kind === "testing"
      ? `<text class="rm-sub" x="${x}" y="${subY}" text-anchor="middle">${escHtml(statusOf(layout, st).toLowerCase())}</text>`
      : "";

  return `<g class="rm-st rm-st--${st.kind}${st.ghost ? " rm-st--ghost" : ""}" ${attrs} tabindex="-1">
    ${stationShape(st.kind, st.ghost, x, y)}${label}${sub}
  </g>`;
}

function statusOf(layout: MapLayout, st: Station): string {
  return layout.items.get(st.keys[0])?.item.status ?? "";
}

function renderTags(layout: MapLayout, g: Geometry & { flagRow: Map<TagMark, number> }): string {
  return layout.tags.map(tag => {
    const x = g.x(tag.col);
    const y = g.y(tag.lane);
    const title = `<title>${escHtml(tag.name || "Next tag")}</title>`;
    if (tag.style === "flag") {
      const row = g.flagRow.get(tag) ?? 0;
      const pillY = g.mainY - 50 - row * FLAG_ROW;
      return `<g class="rm-tag rm-tag--flag">${title}
        <path class="rm-tag-leader" d="M${x} ${pillY + 9}V${g.mainY - 29}"/>
        ${renderPill(x, pillY, shortTag(tag.name), "rm-tagpill")}
      </g>`;
    }
    const text = tag.name ? shortTag(tag.name) : "next tag";
    return `<g class="rm-tag rm-tag--${tag.style}">${title}${renderPill(x, y, text, "rm-tagpill", tag.style === "next" ? "next" : "")}</g>`;
  }).join("");
}

function renderHead(layout: MapLayout, g: Geometry): string {
  // HEAD only means something where the line goes on after it.
  const marks: Array<[Lane, number]> = [["main", layout.main.head]];
  return marks
    .filter(([, col]) => layout.stations.some(s => s.lane === "main" && s.col === col && !s.ghost) || layout.main.to > col)
    .map(([lane, col]) => `<text class="rm-head" x="${g.x(col) + 11}" y="${g.y(lane) + 20}">HEAD</text>`)
    .join("");
}

// ── Legend ────────────────────────────────────────────────────────────────────

function legendGlyph(kind: StationKind): string {
  const body: Record<StationKind, string> = {
    landed:    `<circle cx="7" cy="7" r="5" class="rm-g rm-g--landed"/>`,
    extra:     `<path d="M7 1.5L12.5 7L7 12.5L1.5 7Z" class="rm-g rm-g--extra"/>`,
    "to-pick": `<circle cx="7" cy="7" r="4.6" class="rm-g rm-g--ghost"/>`,
    testing:   `<circle cx="7" cy="7" r="4.6" class="rm-g rm-g--testing"/>`,
    incoming:  `<circle cx="7" cy="7" r="4.6" class="rm-g rm-g--ghost"/>`,
    earlier:   `<rect x="1" y="3" width="12" height="8" rx="4" class="rm-g rm-g--pill"/>`,
    cluster:   `<rect x="1" y="3" width="12" height="8" rx="4" class="rm-g rm-g--pill"/>`,
  };
  return `<svg class="rm-legend-glyph" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">${body[kind]}</svg>`;
}

function legendEntries(layout: MapLayout): Array<[StationKind, string]> {
  const c = layout.counts;
  const next = layout.nextTag ? shortTag(layout.nextTag) : "the next tag";
  if (layout.mode === "beta") {
    return [
      ["landed", `<b>${c.landed}</b> going into ${escHtml(next)}`],
      ["extra", `<b>${c.extra}</b> not planned, shipping anyway`],
      ["incoming", `<b>${c.incoming}</b> not merged yet`],
      ["earlier", `<b>${c.earlier}</b> shipped before ${escHtml(shortTag(layout.sinceTag) || "the last tag")}`],
    ];
  }
  return [
    ["landed", `<b>${c.landed}</b> on ${escHtml(layout.branch?.name ?? "the branch")}`],
    ["to-pick", `<b>${c["to-pick"] - layout.blocked}</b> to cherry-pick${
      layout.blocked > 0 ? `, <b>${layout.blocked}</b> held back by ${layout.blocked === 1 ? "its PR" : "their PRs"}` : ""}`],
    ["testing", `<b>${c.testing}</b> still in testing`],
    ["incoming", `<b>${c.incoming}</b> not on main yet`],
    ["extra", `<b>${c.extra}</b> not planned`],
  ];
}

function renderLegend(layout: MapLayout): string {
  const entries = legendEntries(layout)
    .filter(([kind]) => layout.counts[kind] > 0 || kind === "landed")
    .map(([kind, text]) => `<span class="rm-legend-item rm-legend-item--${kind}">${legendGlyph(kind)}<span>${text}</span></span>`)
    .join("");
  const quiet = layout.mode === "beta" && layout.counts.landed + layout.counts.extra === 0
    ? `<span class="rm-legend-note">Nothing merged since ${escHtml(shortTag(layout.sinceTag) || "the last tag")}</span>`
    : "";
  return `<div class="rm-legend">${entries}${quiet}</div>`;
}

// ── Public ────────────────────────────────────────────────────────────────────

export interface MapRenderOptions {
  /** Keys the current tab shows; stops outside it fade. null = everything. */
  visibleKeys: Set<string> | null;
  collapsed: boolean;
  zoom: number;
}

export const MAP_ZOOM_MIN = 0.5;
export const MAP_ZOOM_MAX = 1.75;

export function clampMapZoom(zoom: number): number {
  return Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, zoom));
}

/**
 * Rescales a rendered map in place — the SVG keeps its viewBox, so it stays
 * crisp, and nothing is rebuilt (hover state survives a pinch).
 */
export function applyMapZoom(panel: HTMLElement, zoom: number) {
  const svg = panel.querySelector<SVGSVGElement>(".rm-svg");
  if (svg) {
    svg.setAttribute("width", String(Number(svg.dataset.rmW) * zoom));
    svg.setAttribute("height", String(Number(svg.dataset.rmH) * zoom));
  }
  panel.querySelectorAll<HTMLElement>("[data-rm-y]").forEach(el => {
    el.style.top = `${Number(el.dataset.rmY) * zoom}px`;
  });
  const label = panel.querySelector<HTMLElement>("[data-rm-zoom-label]");
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  panel.querySelector<HTMLButtonElement>(`[data-rm-zoom="out"]`)?.toggleAttribute("disabled", zoom <= MAP_ZOOM_MIN + 0.001);
  panel.querySelector<HTMLButtonElement>(`[data-rm-zoom="in"]`)?.toggleAttribute("disabled", zoom >= MAP_ZOOM_MAX - 0.001);
}

/** The zoom at which the whole map fits the visible width (never above 150%). */
export function fitMapZoom(panel: HTMLElement): number {
  const svg = panel.querySelector<SVGSVGElement>(".rm-svg");
  const scroller = panel.querySelector<HTMLElement>("[data-rm-scroll]");
  if (!svg || !scroller) return 1;
  return clampMapZoom(Math.min(1.5, (scroller.clientWidth - 8) / Number(svg.dataset.rmW)));
}

const ZOOM_ICON = {
  out: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 6h7"/></svg>`,
  in: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 2.5v7M2.5 6h7"/></svg>`,
  fit: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4V1.5H4M8 1.5h2.5V4M10.5 8v2.5H8M4 10.5H1.5V8"/></svg>`,
};

function renderZoomControls(zoom: number): string {
  return `<div class="rm-zoom" role="group" aria-label="Map zoom">
      <button class="rm-zoom-btn" data-rm-zoom="out" title="Zoom out (⌘/Ctrl + scroll)" aria-label="Zoom out">${ZOOM_ICON.out}</button>
      <button class="rm-zoom-val" data-rm-zoom="reset" data-rm-zoom-label title="Reset to 100%">${Math.round(zoom * 100)}%</button>
      <button class="rm-zoom-btn" data-rm-zoom="in" title="Zoom in (⌘/Ctrl + scroll)" aria-label="Zoom in">${ZOOM_ICON.in}</button>
      <button class="rm-zoom-btn" data-rm-zoom="fit" title="Fit the whole map" aria-label="Fit the whole map">${ZOOM_ICON.fit}</button>
    </div>`;
}

export function renderReleaseMap(layout: MapLayout, opts: MapRenderOptions): string {
  // Folding is an action, not a view switch: a plain "Hide map" / "Show map"
  // at the end of the row, next to the zoom it hides along with the map.
  const chevron = opts.collapsed ? "M2.5 4l2.5 2.5L7.5 4" : "M2.5 6l2.5-2.5L7.5 6";
  const header = `<div class="rm-head-row">
      ${renderLegend(layout)}
      <div class="rm-head-actions">
        ${opts.collapsed ? "" : renderZoomControls(opts.zoom)}
        <button class="rm-toggle" data-rm-toggle aria-expanded="${!opts.collapsed}">
          ${opts.collapsed ? "Show map" : "Hide map"}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${chevron}"/></svg>
        </button>
      </div>
    </div>`;
  if (opts.collapsed) return header;

  const g = geometry(layout);
  const laneWidth = Math.min(170, Math.max(72, Math.ceil(
    Math.max(layout.main.name.length, layout.branch?.name.length ?? 0) * 6.8 + 26,
  )));
  const lanes = [
    `<div class="rm-lane-name" data-rm-y="${g.mainY}" style="top:${g.mainY * opts.zoom}px" title="${escHtml(layout.main.name)}">${escHtml(layout.main.name)}</div>`,
    layout.branch
      ? `<div class="rm-lane-name rm-lane-name--branch" data-rm-y="${g.branchY}" style="top:${g.branchY * opts.zoom}px" title="${escHtml(layout.branch.name)}">${escHtml(layout.branch.name)}</div>`
      : "",
  ].join("");

  const stations = layout.stations.map(st => {
    const html = renderStation(st, layout, g);
    return isDimmed(st.keys, opts.visibleKeys) ? html.replace(`class="rm-st `, `class="rm-st rm-dim `) : html;
  }).join("");

  const svg = `<svg class="rm-svg" width="${g.width * opts.zoom}" height="${g.height * opts.zoom}" data-rm-w="${g.width}" data-rm-h="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="Release map">
    ${renderLines(layout, g)}
    ${renderLinks(layout, g, opts.visibleKeys)}
    ${renderTags(layout, g)}
    ${stations}
    ${renderHead(layout, g)}
  </svg>`;

  return `${header}
    <div class="rm-canvas" style="grid-template-columns:${laneWidth}px 1fr">
      <div class="rm-lanes">${lanes}</div>
      <div class="rm-scroll" data-rm-scroll>${svg}</div>
      <div class="rm-tip" data-rm-tip hidden></div>
    </div>`;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function otherVersions(item: MapItem): string {
  return item.fixVersions.filter(v => v && v !== "Unscheduled").join(", ") || "no release";
}

function describe(layout: MapLayout, kind: StationKind, item: MapItem, openPr?: { number: number }): string {
  const branch = layout.branch?.name ?? "";
  const next = layout.nextTag ? shortTag(layout.nextTag) : "the next tag";
  if (layout.mode === "beta") {
    switch (kind) {
      case "landed": return `Merged on main — ships with ${next}`;
      case "extra": return `Planned for ${otherVersions(item)}, but on main — ships with ${next} anyway`;
      case "earlier": return `Already shipped before ${shortTag(layout.sinceTag)}`;
      default:
        if (openPr) return `Not merged yet — PR #${openPr.number} is open`;
        if (item.flag === "no-pr") return `Jira says ${item.status}, but nothing is merged on main`;
        return `Not merged yet — no PR open`;
    }
  }
  switch (kind) {
    case "landed": return `Cherry-picked to ${branch}`;
    case "extra": return `On ${branch}, but planned for ${otherVersions(item)}`;
    case "to-pick": return `${item.status} — not on ${branch} yet: ready to cherry-pick`;
    case "testing": return `On main, still ${item.status} — not ready to pick`;
    default: return openPr ? `Not on main yet — PR #${openPr.number} is open` : `Not on main yet`;
  }
}

export function renderTooltip(
  layout: MapLayout,
  station: Station,
  statusChip: (status: string) => string,
  openPrs: Record<string, { number: number }>,
): string {
  if (station.kind === "cluster") {
    const titles = station.titles ?? [];
    const shown = titles.slice(-6).reverse().map(t => `<li>${escHtml(t)}</li>`).join("");
    const more = titles.length > 6 ? `<li class="rm-tip-more">+${titles.length - 6} more</li>` : "";
    return `<div class="rm-tip-kind">${titles.length} other PR${titles.length === 1 ? "" : "s"} on main</div>
      <ul class="rm-tip-list">${shown}${more}</ul>`;
  }
  if (station.kind === "earlier") {
    const rows = station.keys.slice(0, 8).map(k => {
      const item = layout.items.get(k)?.item;
      return `<li><span class="rm-tip-key">${escHtml(k)}</span> ${escHtml(item?.summary ?? "")}</li>`;
    }).join("");
    const more = station.keys.length > 8 ? `<li class="rm-tip-more">+${station.keys.length - 8} more</li>` : "";
    return `<div class="rm-tip-kind">Shipped before ${escHtml(shortTag(layout.sinceTag))} — done in Jira, no merge since</div>
      <ul class="rm-tip-list">${rows}${more}</ul>`;
  }

  const entry = layout.items.get(station.keys[0]);
  if (!entry) return "";
  const { item } = entry;
  const kind = station.kind;
  const openPr = openPrs[item.key];
  const avatar = item.author
    ? item.avatarUrl
      ? `<img class="rm-tip-avatar" src="${escHtml(item.avatarUrl)}" alt="" width="14" height="14"/>`
      : `<span class="rm-tip-avatar" style="background:${escHtml(item.avatarColor)}">${escHtml(item.initials)}</span>`
    : "";
  // A stop on main tells its main merge; on the branch (or in beta mode) the
  // item's own PR and date. An open PR is told by the description line below.
  const onMain = station.mainPr && station.lane === "main";
  const prNumber = onMain ? station.mainPr?.number : item.prNumber;
  const when = fmtDate(onMain ? station.mainPr?.mergedAt : item.mergedAt);
  const verb = layout.mode === "branch" && !onMain ? "picked" : layout.mode === "branch" ? "on main" : "merged";
  const meta = [
    item.author ? `${avatar}<span>${escHtml(item.author)}</span>` : "",
    prNumber ? `<span>PR #${prNumber}</span>` : "",
    when ? `<span>${verb} ${escHtml(when)}</span>` : "",
  ].filter(Boolean).join(`<span class="rm-tip-sep">·</span>`);
  if (station.keys.length > 1) {
    const pr = prNumber ?? openPr?.number;
    const rows = station.keys.map(k => {
      const story = layout.items.get(k)?.item;
      return `<li class="rm-tip-story">
          <span class="rm-tip-key">${escHtml(k)}</span>
          <span class="rm-tip-story-title">${escHtml(story?.summary ?? "")}</span>
          ${statusChip(story?.status ?? "")}
        </li>`;
    }).join("");
    return `<div class="rm-tip-hd"><span class="rm-tip-key">${pr ? `PR #${pr} · ` : ""}${station.keys.length} stories</span></div>
      <ul class="rm-tip-stories">${rows}</ul>
      ${meta ? `<div class="rm-tip-meta">${meta}</div>` : ""}
      <div class="rm-tip-kind rm-tip-kind--${kind}">${escHtml(describeGroup(layout, station, openPr))}</div>`;
  }

  return `<div class="rm-tip-hd"><span class="rm-tip-key">${escHtml(item.key)}</span>${statusChip(item.status)}</div>
    <div class="rm-tip-title">${escHtml(item.summary)}</div>
    ${meta ? `<div class="rm-tip-meta">${meta}</div>` : ""}
    <div class="rm-tip-kind rm-tip-kind--${kind}">${escHtml(describe(layout, kind, item, openPr))}</div>`;
}

function keysOfKind(layout: MapLayout, station: Station, kind: StationKind): string[] {
  return station.keys.filter(k => layout.items.get(k)?.kind === kind);
}

/** The verdict for a stop carrying several stories, naming the ones that decide it. */
function describeGroup(layout: MapLayout, station: Station, openPr?: { number: number }): string {
  const branch = layout.branch?.name ?? "";
  const next = layout.nextTag ? shortTag(layout.nextTag) : "the next tag";
  const unplanned = keysOfKind(layout, station, "extra").join(", ");
  switch (station.kind) {
    case "landed":
      return layout.mode === "beta" ? `Merged on main together — ship with ${next}` : `Cherry-picked to ${branch} together`;
    case "extra":
      return layout.mode === "beta"
        ? `Ships with ${next}, carrying stories not planned here: ${unplanned}`
        : `On ${branch}, carrying stories not planned here: ${unplanned}`;
    case "testing": {
      const waiting = keysOfKind(layout, station, "testing");
      if (keysOfKind(layout, station, "to-pick").length === 0) return `On main, not verified yet — nothing to pick`;
      const who = waiting.length === 1
        ? `${waiting[0]} is still ${layout.items.get(waiting[0])?.item.status ?? "in testing"}`
        : `${waiting.join(", ")} are not verified yet`;
      return `One PR, picked whole: blocked until ${who}`;
    }
    case "to-pick":
      return `All verified — ready to cherry-pick to ${branch}`;
    default:
      return openPr ? `Not merged yet — PR #${openPr.number} is open` : `Not merged yet — no PR open`;
  }
}
