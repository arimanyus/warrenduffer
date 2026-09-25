const IST = "Asia/Kolkata";

/** Every trading-path timestamp reads this. Replay swaps it for a virtual clock. */
export const clock = { now: (): number => Date.now() };

export function useVirtualClock(startMs: number): { set: (ms: number) => void } {
  let t = startMs;
  clock.now = () => t;
  return { set: (ms: number) => (t = ms) };
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

/**
 * Broker timestamps → epoch ms, independent of the host timezone. Explicit offsets ("+0530", "+05:30", "Z")
 * are honoured; offset-less wall-clock strings ("2026-09-15 09:15:00", "15-Sep-2026 09:15:00") are IST;
 * bare numbers are epoch seconds or ms. Date.parse alone would read wall-clock strings in the server's zone.
 */
export function parseIstTimestamp(v: unknown): number {
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseIstTimestamp(Number(s));
  const iso = s.replace(" ", "T");
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) {
    return Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - IST_OFFSET_MS;
  const d = /^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (d) {
    const mon = MONTHS.indexOf(d[2].toLowerCase());
    if (mon >= 0) return Date.UTC(+d[3], mon, +d[1], +d[4], +d[5], +(d[6] ?? 0)) - IST_OFFSET_MS;
  }
  return NaN;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Epoch ms of 00:00 IST on the IST day containing `ms`. */
export function istDayStartMs(ms = clock.now()): number {
  return istDayIndex(ms) * 86400_000 - IST_OFFSET_MS;
}

export function isWeekday(ms = clock.now()): boolean {
  const w = new Date(ms + IST_OFFSET_MS).getUTCDay();
  return w !== 0 && w !== 6;
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
