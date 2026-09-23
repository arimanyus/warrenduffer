/**
 * Kite access tokens expire daily (~06:00 IST) and Kite forbids automated login, so this is the manual daily step.
 *   pnpm zerodha:login                   prints the login URL
 *   pnpm zerodha:login <request_token>   exchanges it and prints ZERODHA_ACCESS_TOKEN=... for .env
 */
import { cfg } from "../src/config.js";
import { exchangeRequestToken, loginUrl } from "../src/zerodha/client.js";

async function main(): Promise<void> {
  if (!cfg.zerodhaApiKey) {
    console.error("set ZERODHA_API_KEY (and ZERODHA_API_SECRET) in .env");
    process.exit(1);
  }
  const requestToken = process.argv.slice(2).find((a) => a !== "--");
  if (!requestToken) {
    console.log(`1. open ${loginUrl(cfg.zerodhaApiKey)}`);
    console.log("2. log in; copy request_token from the redirect URL");
    console.log("3. pnpm zerodha:login <request_token>");
    return;
  }
  const token = await exchangeRequestToken(cfg.zerodhaApiKey, requestToken, cfg.zerodhaApiSecret);
  console.log("paste into .env, then restart:");
  console.log(`ZERODHA_ACCESS_TOKEN=${token}`);
}

void main().catch((e) => {
  console.error("zerodha login failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
