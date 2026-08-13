# Delphi Agent Arena — Status

## ✅ BUILD COMPLETE — Production-ready trading agent

### What's Built
- **Autonomous trading agent** (`src/agent.ts`) — 5-min loop: scan markets → analyze → buy → sync → redeem/liquidate
- **Rules-based strategy** (`src/strategy.ts`) — LLM-free, domain heuristics + contrarian shrinkage estimator
- **SDK wrapper** (`src/delphi.ts`) — DelphiClient wrapper for competition-testnet
- **Portfolio tracker** (`src/portfolio.ts`) — P&L ledger, persisted to `data/portfolio.json`
- **Dashboard** (`src/dashboard/server.ts` + `api/index.ts`) — read-only web UI, deployed to Vercel
- **Smoke test** (`src/scripts/smoke.ts`) — verifies connection without trading

### Verified
- ✅ TypeScript compiles cleanly (`npm run build`)
- ✅ Smoke test against live Gensyn Testnet: health=ok, wallet loaded, balances read
- ✅ Deployed to Vercel: https://delphi-agent-arena.vercel.app
- ✅ Pushed to GitHub: https://github.com/0xConsole/delphi-agent-arena

### Registration (from prior session)
- DoraHacks hackathon ID: 2320
- BUIDL ID: 47649 (SentinelTrader)
- Submission ID: 53631
- Track: 4565 (Autonomous Trading Agents)
- Wallet: 0x3f567c3254E9Dc9C2813E2a8b71BB3604Ba53155

### BLOCKED — To start trading (manual steps requiring browser/wallet)
1. **Get testnet ETH** — wallet needs gas. Faucets require browser (Cloudflare-blocked for CLI).
2. **Get $TST tokens** — competition token, auto-funded after wallet allowlisted.
3. **Generate Delphi API key** — https://delphi-api-access.gensyn.ai/ (requires wallet signing via browser with injected provider).

### How to run once funded
```bash
cd /root/money/hackathons/delphi-agent-arena
cp .env.example .env
# Fill in WALLET_PRIVATE_KEY and DELPHI_API_ACCESS_KEY
npm install
npm run smoke   # verify connection
npm start       # start trading + dashboard on :3001
```

### Competition Timeline
- Trading window: Aug 10 - Aug 24
- Deadline: Aug 23 23:59 UTC
- Prize: $10K (1st $5K, 2nd $3K, 3rd $2K)
