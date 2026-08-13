/**
 * Main entry point — boots the agent + dashboard together.
 *
 *   npm start            (compiled)
 *   npm run dev          (via tsx)
 *
 * The agent runs the trading loop; the dashboard serves a read-only web UI
 * on DASHBOARD_PORT (default 3001) showing positions, P&L, and trade history.
 */

import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { createDashboard } from "./dashboard/server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Delphi Agent Arena — autonomous trading bot            ║");
  console.log("║  DoraHacks Delphi Agent Arena Competition ($10K)        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  network: ${cfg.network}`);
  console.log(`  loop interval: ${cfg.loopIntervalMs / 1000}s`);
  console.log(`  max risk/trade: ${cfg.maxRiskPct}%`);
  console.log(`  min edge: ${cfg.minEdge}`);
  console.log(`  max positions: ${cfg.maxPositions}`);
  console.log(`  dashboard: http://localhost:${cfg.dashboardPort}`);

  if (!cfg.privateKey) {
    console.error("\n❌ WALLET_PRIVATE_KEY is required. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  if (!cfg.apiKey) {
    console.error("\n❌ DELPHI_API_ACCESS_KEY is required. Generate one at https://delphi-api-access.gensyn.ai/");
    process.exit(1);
  }

  const agent = new Agent(cfg);

  // Start dashboard first so it's available even if the agent errors
  createDashboard(agent, cfg.dashboardPort);

  // Graceful shutdown
  const shutdown = (sig: string) => {
    console.log(`\n[main] received ${sig}, shutting down...`);
    agent.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await agent.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
