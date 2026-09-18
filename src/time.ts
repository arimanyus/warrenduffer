const IST = "Asia/Kolkata";

export function nowMs(): number {
  return Date.now();
}

export function istParts(ms = Date.now()): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: string;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
    weekday: parts.weekday ?? "",
  };
}

export function istDateStr(ms = Date.now()): string {
  const p = istParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function istTimeStr(ms = Date.now()): string {
  const p = istParts(ms);
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
}

export function minutesOfDay(ms = Date.now()): number {
  const p = istParts(ms);
  return p.hh * 60 + p.mm;
}

export function isWeekday(ms = Date.now()): boolean {
  const w = istParts(ms).weekday;
  return w !== "Sat" && w !== "Sun";
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
