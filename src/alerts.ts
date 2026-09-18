import { cfg } from "./config.js";
import { insertEvent } from "./db.js";

function safeLog(line: string): void {
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* stdout gone (detached terminal); the DB row is the record */
  }
}

export async function alert(kind: string, message: string): Promise<void> {
  try {
    insertEvent(kind, message);
  } catch {
    /* never let logging throw */
  }
  safeLog(`[alert:${kind}] ${message}`);
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
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

export function installCrashHandler(): void {
  // A closed terminal makes every console write throw EPIPE; swallow those instead of alerting in a loop.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const isPipe = (err: unknown) => err instanceof Error && /EPIPE|EIO/.test(err.message);
  process.on("uncaughtException", (err) => {
    if (isPipe(err)) return;
    void alert("crash", String(err));
  });
  process.on("unhandledRejection", (err) => {
    if (isPipe(err)) return;
    void alert("crash", String(err));
  });
}
