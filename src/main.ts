import { installCrashHandler } from "./alerts.js";
import { cfg } from "./config.js";
import { KotakClient } from "./kotak/client.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";
import { alert } from "./alerts.js";

installCrashHandler();

const client = new KotakClient(() => {
  void alert("session", "session expired and re-login failed; entries halted");
});

const engine = new Engine(client);

async function main(): Promise<void> {
  if (!cfg.kotakAccessToken || !cfg.kotakUcc) {
    console.error("Set KOTAK_* in .env (see .env.example). Starting dashboard-only with empty session.");
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
}

void main();
