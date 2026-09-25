import { cfg } from "./config.js";
import { insertEvent } from "./db.js";

const DEDUPE_MS = 60_000;
const pending = new Set<Promise<void>>();
const lastSent = new Map<string, number>();

function safeLog(line: string): void {
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* stdout gone (detached terminal); the DB row is the record */
  }
}

async function sendTelegram(kind: string, message: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `[${kind}] ${message}` }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    safeLog(`telegram failed ${e}`);
  }
}

/**
 * Records and logs synchronously; Telegram delivery runs in the background so a slow or blocked
 * Telegram never delays the cancel/flatten that usually follows an alert. Identical alerts within
 * a minute are recorded but not re-sent.
 */
export function alert(kind: string, message: string): Promise<void> {
  try {
    insertEvent(kind, message);
  } catch {
    /* never let logging throw */
  }
  safeLog(`[alert:${kind}] ${message}`);
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return Promise.resolve();
  const key = `${kind}\u0000${message}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < DEDUPE_MS) return Promise.resolve();
  lastSent.set(key, now);
  if (lastSent.size > 500) for (const [k, t] of lastSent) if (now - t >= DEDUPE_MS) lastSent.delete(k);
  const p: Promise<void> = sendTelegram(kind, message).finally(() => pending.delete(p));
  pending.add(p);
  return Promise.resolve();
}

/** Wait (bounded) for in-flight Telegram sends, e.g. before a fatal exit. */
export async function flushAlerts(timeoutMs = 5000): Promise<void> {
  if (!pending.size) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

const FATAL_GRACE_MS = 15_000;

/**
 * An uncaught exception leaves the engine in an unknown state, so it is fatal: alert, run `onFatal`
 * (kill switch + flatten attempt) for at most 15 s, flush alerts, exit non-zero so systemd restarts
 * into a clean reconcile. Unhandled rejections are alerted but not fatal.
 */
export function installCrashHandler(onFatal?: () => Promise<void>): void {
  // A closed terminal makes every console write throw EPIPE; swallow those instead of alerting in a loop.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const isPipe = (err: unknown) => err instanceof Error && /EPIPE|EIO/.test(err.message);
  let dying = false;
  process.on("uncaughtException", (err) => {
    if (isPipe(err)) return;
    void alert("crash", `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`.slice(0, 1500));
    if (dying) return;
    dying = true;
    let timer: NodeJS.Timeout | undefined;
    void Promise.race([
      (onFatal?.() ?? Promise.resolve()).catch((e) => safeLog(`fatal handler failed ${e}`)),
      new Promise<void>((r) => {
        timer = setTimeout(r, FATAL_GRACE_MS);
      }),
    ])
      .then(() => {
        clearTimeout(timer);
        return flushAlerts(3000);
      })
      .finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (err) => {
    if (isPipe(err)) return;
    void alert("crash", String(err));
  });
}
