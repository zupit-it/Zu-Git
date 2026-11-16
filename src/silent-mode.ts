// ── Silent mode ───────────────────────────────────────────────────────────────
// Settings → Silent mode: between two times of day nothing ZuGit does on its
// own interrupts — no system notification, no Tiny King, no planner opening by
// itself. Whatever would interrupt asks here first; the backend asks the same
// of `silent_mode.rs`, which must agree with this file.

export interface SilentWindow {
  enabled: boolean;
  /** Local "HH:MM": silent from this minute on. */
  from: string;
  /** Local "HH:MM": no longer silent from this minute on. */
  to: string;
}

/** "HH:MM" → minutes from midnight; anything else, none. */
function minutesOf(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

/**
 * Whether `now`, in local time, falls in the window.
 *
 * `from` is in, `to` is out. `from` after `to` is a window crossing midnight
 * (14:00 → 08:00 is until 08:00 the next day). `from` equal to `to` is the
 * whole day: the window runs until that time tomorrow, like any other whose
 * end is not after its start — a switch that is on never silences nothing.
 * A time that cannot be read silences nothing.
 */
export function isSilentAt(mode: SilentWindow, now: Date): boolean {
  if (!mode.enabled) return false;
  const from = minutesOf(mode.from);
  const to = minutesOf(mode.to);
  if (from === null || to === null) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** The window as its settings card says it, closed: "14:00 → 08:00", or "All day". */
export function silentWindowLabel(mode: Pick<SilentWindow, "from" | "to">): string {
  return mode.from === mode.to ? "All day" : `${mode.from} → ${mode.to}`;
}
