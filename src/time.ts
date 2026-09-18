const IST = "Asia/Kolkata";

/** Every trading-path timestamp reads this. Replay swaps it for a virtual clock. */
export const clock = { now: (): number => Date.now() };

export function useVirtualClock(startMs: number): { set: (ms: number) => void } {
  let t = startMs;
  clock.now = () => t;
  return { set: (ms: number) => (t = ms) };
}

export function nowMs(): number {
  return clock.now();
}

/** IST is UTC+05:30 with no DST, so shifting the epoch and reading UTC fields is exact and ~1000x faster than Intl. */
const IST_OFFSET_MS = 5.5 * 3600_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
void IST;

export function istParts(ms = clock.now()): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: string;
} {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    ss: d.getUTCSeconds(),
    weekday: WEEKDAYS[d.getUTCDay()] ?? "",
  };
}

export function istDateStr(ms = clock.now()): string {
  const p = istParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function istTimeStr(ms = clock.now()): string {
  const p = istParts(ms);
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
}

export function minutesOfDay(ms = clock.now()): number {
  const ist = ms + IST_OFFSET_MS;
  return Math.floor((ist % 86400_000) / 60_000);
}

/** IST calendar day index (days since epoch in IST); cheap grouping key. */
export function istDayIndex(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / 86400_000);
}

export function isWeekday(ms = clock.now()): boolean {
  const w = new Date(ms + IST_OFFSET_MS).getUTCDay();
  return w !== 0 && w !== 6;
}

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
