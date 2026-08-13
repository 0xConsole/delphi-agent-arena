/**
 * Smoke test — verifies the agent can connect to the Delphi API and read
 * competition markets WITHOUT placing any trades.
 *
 *   npm run smoke
 *
 * Requirements: DELPHI_API_ACCESS_KEY set (wallet optional for the read path,
 * but the SDK needs a signer, so set WALLET_PRIVATE_KEY too).
 */

import { loadConfig } from "../config.js";
import { Delphi, fmtTokens } from "../delphi.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log("[smoke] config:", { network: cfg.network, hasKey: !!cfg.apiKey, hasPk: !!cfg.privateKey });

  const delphi = new Delphi(cfg);

  // 1. Health
  try {
    const status = await delphi.health();
    console.log(`[smoke] health: ${status} ✓`);
  } catch (err) {
    console.error("[smoke] health FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // 2. Wallet + balances (needs signer)
  if (cfg.privateKey) {
    try {
      const addr = await delphi.getAddress();
      console.log(`[smoke] wallet: ${addr}`);
      const eth = await delphi.getEthBalance();
      const tokens = await delphi.getTokenBalance();
      console.log(`[smoke] ETH balance: ${fmtTokens(eth * 10n ** 12n)}`);
      console.log(`[smoke] $TST balance: ${fmtTokens(tokens)}`);
    } catch (err) {
      console.error("[smoke] balance read FAILED:", err instanceof Error ? err.message : err);
    }
  } else {
    console.log("[smoke] no WALLET_PRIVATE_KEY — skipping balance reads");
  }

  // 3. List open competition markets
  try {
    const markets = await delphi.listOpenMarkets(20);
    console.log(`[smoke] open competition markets: ${markets.length}`);
    for (const m of markets.slice(0, 10)) {
      const q = m.metadata?.question ?? "(no question)";
      const probs = m.spotImpliedProbabilities;
      const pStr = probs && probs.length
        ? probs.map((p) => (p * 100).toFixed(1) + "%").join(" / ")
        : "n/a";
      console.log(`  • ${m.category.padEnd(8)} | ${q.slice(0, 70).padEnd(70)} | ${pStr}`);
    }
    if (markets.length === 0) {
      console.log("[smoke] ⚠️  no open markets — competition may not have started or API key not authorised for competition mode");
    }
  } catch (err) {
    console.error("[smoke] listMarkets FAILED:", err instanceof Error ? err.message : err);
  }

  // 4. List positions
  if (cfg.privateKey) {
    try {
      const addr = await delphi.getAddress();
      const positions = await delphi.listOpenPositions(addr);
      console.log(`[smoke] open positions: ${positions.length}`);
    } catch (err) {
      console.error("[smoke] listPositions FAILED:", err instanceof Error ? err.message : err);
    }
  }

  console.log("[smoke] done — no trades placed.");
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
