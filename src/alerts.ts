import { cfg } from "./config.js";
import { insertEvent } from "./db.js";

export async function alert(kind: string, message: string): Promise<void> {
  insertEvent(kind, message);
  console.log(`[alert:${kind}] ${message}`);
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: `[${kind}] ${message}` }),
    });
  } catch (e) {
    console.error("telegram failed", e);
  }
}

export function installCrashHandler(): void {
  process.on("uncaughtException", (err) => {
    void alert("crash", String(err));
  });
  process.on("unhandledRejection", (err) => {
    void alert("crash", String(err));
  });
}
