# 🎯 Delphi Agent Arena

Autonomous AI trading agent for the **DoraHacks Delphi Agent Arena Competition** ($10K). The agent trades prediction markets on the Gensyn Testnet using the official [`@gensyn-ai/gensyn-delphi-sdk`](https://www.npmjs.com/package/@gensyn-ai/gensyn-delphi-sdk), and is judged on P&L.

> Live-trading competition — no submission form. Register your wallet, deploy the agent, and let it trade.

## Features

- **Fully autonomous trading loop** — lists competition markets, analyzes prices, buys underpriced outcomes, redeems/liquidates at settlement, every 5 minutes.
- **Rules-based, LLM-free strategy** — deterministic, inspectable, and reliable. Uses domain heuristics (crypto / sports / politics / economics) + a contrarian shrinkage estimator for thin prediction markets.
- **Risk-managed position sizing** — quarter-Kelly, capped at 1–5% of balance per trade, max concurrent positions enforced.
- **On-chain position tracking** — syncs real positions from the Delphi subgraph, tracks cost basis and realized P&L, persists state to disk.
- **Live dashboard** — read-only web UI showing balances, positions, trade history, and P&L. Deployable to Vercel.
- **Production-ready** — just add a funded wallet + API key and it trades. Built and smoke-tested against the real Gensyn Testnet.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#   Fill in WALLET_PRIVATE_KEY and DELPHI_API_ACCESS_KEY

# 3. Verify the connection (no trades placed)
npm run smoke

# 4. Build
npm run build

# 5. Run the agent + dashboard
npm start
# Dashboard: http://localhost:3001
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WALLET_PRIVATE_KEY` | ✅ | Hex private key (`0x...`) for signing trades |
| `DELPHI_API_ACCESS_KEY` | ✅ | REST API key from [delphi-api-access.gensyn.ai](https://delphi-api-access.gensyn.ai/) |
| `DELPHI_NETWORK` | — | `competition-testnet` (default) |
| `AGENT_LOOP_INTERVAL_MS` | — | Loop interval (default `300000` = 5 min) |
| `AGENT_MAX_RISK_PCT` | — | Max % of balance per trade (default `3`) |
| `AGENT_MIN_EDGE` | — | Min edge to act, 0–1 (default `0.08` = 8pp) |
| `AGENT_SLIPPAGE_PCT` | — | Buy slippage tolerance % (default `2`) |
| `AGENT_MAX_POSITIONS` | — | Max concurrent positions (default `12`) |
| `DASHBOARD_PORT` | — | Dashboard port (default `3001`) |

See [`.env.example`](.env.example) for the full list including network overrides.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        src/index.ts                       │
│   boots Agent (trading loop) + Dashboard (HTTP server)    │
└──────────────┬───────────────────────────┬──────────────┘
               │                           │
       ┌───────▼────────┐         ┌────────▼─────────┐
       │   agent.ts      │         │ dashboard/server │
       │  trading loop   │         │  read-only HTTP  │
       │  (5 min cycle)  │         │  /status /api    │
       └───┬────┬────┬──┘         └────────┬─────────┘
           │    │    │                     │
  ┌────────▼─┐ ┌▼───────┐ ┌────────▼─┐  ┌───▼──────────┐
  │ delphi.ts│ │strategy│ │portfolio  │  │  data/       │
  │ SDK wrap │ │ signals │ │ P&L ledger│  │ portfolio.json│
  └────┬─────┘ └────────┘ └───────────┘  └──────────────┘
       │
  ┌────▼──────────────────────────┐
  │ @gensyn-ai/gensyn-delphi-sdk  │
  │  listMarkets / buyShares /    │
  │  redeemMarket / liquidate     │
  └────┬──────────────────────────┘
       │
  Gensyn Testnet (chain 685685)
  ── REST API (delphi-api.gensyn.ai)
  ── RPC (gensyn-testnet.g.alchemy.com)
  ── Goldsky subgraph
```

### Trading Cycle (`agent.ts`)

1. **Balance check** — ETH (for gas) + $TST (for trading).
2. **List markets** — `listMarkets({ status: "open", pricesAndImpliedProbabilities: true })` — the SDK sends `X-Delphi-Mode: competition` automatically on `competition-testnet`.
3. **Evaluate** — run the strategy on each market → ranked signals by edge.
4. **Execute** — size and buy the best signals (respecting max positions, no double-buy).
5. **Sync positions** — pull on-chain positions from the subgraph, reconcile cost basis.
6. **Exit** — redeem `settled` winners, liquidate `expired`/`failed` positions.
7. **Record** — persist the portfolio + trade log to `data/portfolio.json`.

## Strategy

The strategy is **LLM-free and rules-based** for reliability — an autonomous bot cannot depend on an LLM that might rate-limit or hallucinate mid-trade.

### Estimation (`strategy.ts`)

Each market's outcome probability is estimated from its question + category:

| Category | Heuristic |
|---|---|
| **Crypto** (price thresholds) | Contrarian shrinkage — fade extreme implied probabilities |
| **Sports** | No team-strength data → mild favourite-fade prior (0.42 vs 0.50) |
| **Politics** | Incumbent-re-election advantage (0.55) / neutral (0.50) |
| **Economics** | Extreme-outcome questions faded (0.35) / neutral (0.50) |
| **Fallback (all)** | Contrarian shrinkage: `est = implied + 0.18 × (0.5 − implied)` |

The **contrarian shrinkage** estimator is the workhorse. In thin prediction markets, the most reliably profitable pattern is fading overconfidence: when the crowd prices an outcome near 0% or 100%, the true probability is rarely that extreme. We only emit an edge when the market is in an extreme zone (implied < 15% or > 85%) and keep the edge conservative.

### Signal generation

A trade signal fires when `|estimatedProb − impliedProb| > minEdge` (default 8pp). The underpriced outcome is bought:
- `edge > 0` → outcome 0 (YES) is underpriced → buy YES
- `edge < 0` → outcome 1 (NO) is underpriced → buy NO

### Position sizing

Quarter-Kelly, clamped for safety:
```
fraction = (edge / (1 − impliedProb)) / 4     # quarter-Kelly
capped at maxRiskPct (3%) of token balance
```

### Exit

| Market status | Exit method |
|---|---|
| `open` | `sellShares` (not used — we hold to settlement) |
| `settled` | `redeemMarket` (claim winning shares) |
| `expired` / `failed` | `liquidate` (recover collateral) |

## Competition Details

| | Value |
|---|---|
| **Prize** | $10,000 (1st $5K / 2nd $3K / 3rd $2K) |
| **Deadline** | Aug 23, 2026 |
| **Network** | Gensyn Testnet (chain ID 685685) |
| **Token** | $TST at `0x8A2d75753362Eb5D5669a2c22cbf394b26a0571F` |
| **Gateway** | `0x097599c9D966fF496284b892A8F13BF885b258ef` |
| **Factory** | `0xEa9D0a78d0209916e88e363B8FDa3e23206Ff49b` |
| **Competition app** | https://competition.delphi.fyi/ |
| **API key** | https://delphi-api-access.gensyn.ai/ (wallet signing required) |

## Deployment

### Dashboard → Vercel

The dashboard deploys to Vercel as a serverless function (`/api/index.ts`):

```bash
vercel --prod
```

The Vercel function reads the persisted `data/portfolio.json` (written by the running agent) and serves the read-only dashboard. Set `VERCEL_TOKEN` to deploy non-interactively.

### Agent loop → long-running host

The trading loop is a long-lived process and must run on a host that stays up (VPS, Railway, fly.io, or a screen/tmux session):

```bash
npm start          # agent + dashboard on :3001
# or just the agent:
node dist/index.js
```

> ⚠️ The wallet must hold **testnet ETH** (for gas) and **$TST** (competition token) before the agent can trade.

## Project Structure

```
├── src/
│   ├── index.ts              # entry — boots agent + dashboard
│   ├── agent.ts              # trading loop (the brain)
│   ├── strategy.ts           # rules-based market analysis + sizing
│   ├── delphi.ts             # SDK wrapper + helpers
│   ├── portfolio.ts          # P&L tracker + persistence
│   ├── config.ts             # env config + decimal helpers
│   ├── dashboard/
│   │   └── server.ts         # HTTP dashboard (standalone)
│   └── scripts/
│       └── smoke.ts          # connection smoke test (no trades)
├── api/
│   └── index.ts              # Vercel serverless dashboard
├── data/                     # portfolio.json (gitignored, runtime state)
├── .env.example
├── vercel.json
├── tsconfig.json
└── package.json
```

## Tech Stack

- **TypeScript** + Node.js (ESM)
- [`@gensyn-ai/gensyn-delphi-sdk`](https://www.npmjs.com/package/@gensyn-ai/gensyn-delphi-sdk) v2.1.0 — official trading SDK
- [viem](https://viem.sh) — EVM interaction (SDK dependency)
- Node built-in `http` — zero-dependency dashboard server
- Vercel — dashboard hosting

## License

MIT — 0xConsole
