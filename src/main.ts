import { installCrashHandler } from "./alerts.js";
import { brokerConfigured, cfg } from "./config.js";
import { createBroker } from "./broker.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";
import { alert } from "./alerts.js";

installCrashHandler();

const client = createBroker(() => {
  void alert("session", cfg.broker === "zerodha" ? "kite session expired; run pnpm zerodha:login, set ZERODHA_ACCESS_TOKEN, restart. Entries halted" : "session expired and re-login failed; entries halted");
});

const engine = new Engine(client);

async function main(): Promise<void> {
  if (!brokerConfigured()) {
    console.error(`Set ${cfg.broker === "zerodha" ? "ZERODHA_*" : "KOTAK_*"} in .env (see .env.example). Starting dashboard-only with empty session.`);
  } else {
    try {
      await engine.start();
    } catch (e) {
      console.error("startup failed (dashboard still up):", e);
      void alert("session", `startup failed ${e}`);
    }
  }
  startServer(engine);
  setInterval(() => {
    void engine.tick().catch((e) => console.error("tick", e));
  }, 2000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      engine.shutdown();
      process.exit(0);
    });
  }
}

void main();
