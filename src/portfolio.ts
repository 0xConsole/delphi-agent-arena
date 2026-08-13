/**
 * In-memory portfolio & P&L tracker.
 *
 * The agent keeps a lightweight in-process ledger of every trade and position
 * so the dashboard can render without a database.  State is also persisted to
 * a JSON file on each update so a restart doesn't lose history.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tokensToFloat, sharesToFloat } from "./config.js";

export interface TradeRecord {
  timestamp: string; // ISO
  marketAddress: string;
  question: string;
  category: string;
  outcomeIdx: number;
  outcomeLabel: string;
  side: "BUY" | "SELL" | "REDEEM" | "LIQUIDATE";
  shares: bigint | null; // 18 decimals
  tokens: bigint | null; // 6 decimals
  txHash: string | null;
  edge?: number | null;
  status: "ok" | "error";
  note?: string;
}

export interface PositionView {
  marketAddress: string;
  question: string;
  category: string;
  outcomeIdx: number;
  outcomeLabel: string;
  shares: bigint; // 18 dec
  costBasisTokens: bigint; // 6 dec
  currentImpliedProb: number | null;
  unrealizedPnlTokens: bigint | null; // 6 dec, estimated
  status: string;
}

export interface PortfolioState {
  walletAddress: string;
  startedAt: string;
  lastLoopAt: string | null;
  loops: number;
  trades: TradeRecord[];
  positions: PositionView[];
  realizedPnlTokens: bigint;
  costBasisByMarket: Record<string, bigint>; // marketAddress#outcomeIdx -> cost
  sharesByMarket: Record<string, bigint>; // marketAddress#outcomeIdx -> shares held
}

const STATE_FILE = process.env.PORTFOLIO_STATE_FILE || join(process.cwd(), "data", "portfolio.json");

function key(m: string, idx: number): string {
  return `${m}#${idx}`;
}

export class Portfolio {
  state: PortfolioState;

  constructor(walletAddress: string) {
    this.state = Portfolio.load(walletAddress);
  }

  static load(walletAddress: string): PortfolioState {
    try {
      if (existsSync(STATE_FILE)) {
        const raw = readFileSync(STATE_FILE, "utf8");
        const parsed = JSON.parse(raw, (k, v) =>
          ["shares", "tokens", "costBasisTokens", "unrealizedPnlTokens", "realizedPnlTokens"].includes(k) && v !== null && typeof v === "string"
            ? BigInt(v)
            : v,
        ) as PortfolioState;
        // Ensure fields exist for forward-compat
        if (!parsed.costBasisByMarket) parsed.costBasisByMarket = {};
        if (!parsed.sharesByMarket) parsed.sharesByMarket = {};
        if (!parsed.trades) parsed.trades = [];
        if (!parsed.positions) parsed.positions = [];
        if (typeof parsed.realizedPnlTokens !== "bigint") parsed.realizedPnlTokens = 0n;
        parsed.walletAddress = walletAddress;
        return parsed;
      }
    } catch (err) {
      console.warn("[portfolio] failed to load state, starting fresh:", err instanceof Error ? err.message : err);
    }
    return {
      walletAddress,
      startedAt: new Date().toISOString(),
      lastLoopAt: null,
      loops: 0,
      trades: [],
      positions: [],
      realizedPnlTokens: 0n,
      costBasisByMarket: {},
      sharesByMarket: {},
    };
  }

  persist(): void {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      const serialised = JSON.stringify(this.state, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      writeFileSync(STATE_FILE, serialised);
    } catch (err) {
      console.warn("[portfolio] failed to persist:", err instanceof Error ? err.message : err);
    }
  }

  recordLoop(): void {
    this.state.loops += 1;
    this.state.lastLoopAt = new Date().toISOString();
    this.persist();
  }

  recordTrade(t: TradeRecord): void {
    this.state.trades.push(t);
    // Keep last 500 trades
    if (this.state.trades.length > 500) {
      this.state.trades = this.state.trades.slice(-500);
    }
    if (t.status === "ok") {
      const k = key(t.marketAddress, t.outcomeIdx);
      if (t.side === "BUY" && t.shares && t.tokens) {
        this.state.costBasisByMarket[k] = (this.state.costBasisByMarket[k] ?? 0n) + t.tokens;
        this.state.sharesByMarket[k] = (this.state.sharesByMarket[k] ?? 0n) + t.shares;
      } else if ((t.side === "SELL" || t.side === "REDEEM" || t.side === "LIQUIDATE") && t.tokens) {
        const cost = this.state.costBasisByMarket[k] ?? 0n;
        const sharesSold = t.shares ?? 0n;
        const totalShares = this.state.sharesByMarket[k] ?? 0n;
        // Pro-rata cost basis
        const costOfSold = totalShares > 0n ? (cost * sharesSold) / totalShares : 0n;
        this.state.costBasisByMarket[k] = cost - costOfSold;
        this.state.sharesByMarket[k] = totalShares - sharesSold;
        this.state.realizedPnlTokens += t.tokens - costOfSold;
      }
    }
    this.persist();
  }

  /** Sync positions from the SDK's on-chain position list. */
  syncPositions(
    onChainPositions: {
      marketProxy: string;
      outcomeIdx: string;
      shares: string;
      marketStatus: string;
    }[],
    marketsById: Map<string, { question: string; category: string; outcomes: string[]; implied: number[] | null }>,
  ): void {
    const views: PositionView[] = [];
    for (const p of onChainPositions) {
      const idx = Number(p.outcomeIdx);
      const shares = BigInt(p.shares || "0");
      if (shares <= 0n) continue;
      const m = marketsById.get(p.marketProxy.toLowerCase());
      const k = key(p.marketProxy, idx);
      const cost = this.state.costBasisByMarket[k] ?? 0n;
      views.push({
        marketAddress: p.marketProxy,
        question: m?.question ?? "(unknown)",
        category: m?.category ?? "",
        outcomeIdx: idx,
        outcomeLabel: m?.outcomes[idx] ?? (idx === 0 ? "YES" : "NO"),
        shares,
        costBasisTokens: cost,
        currentImpliedProb: m?.implied?.[idx] ?? null,
        unrealizedPnlTokens: null, // filled by caller with a mark-to-market estimate
        status: p.marketStatus,
      });
    }
    this.state.positions = views;
    this.persist();
  }

  /** Build a JSON-serialisable snapshot for the dashboard. */
  snapshot(): object {
    const totalCost = this.state.positions.reduce((s, p) => s + p.costBasisTokens, 0n);
    return {
      walletAddress: this.state.walletAddress,
      startedAt: this.state.startedAt,
      lastLoopAt: this.state.lastLoopAt,
      loops: this.state.loops,
      realizedPnlTokens: tokensToFloat(this.state.realizedPnlTokens),
      openPositions: this.state.positions.map((p) => ({
        marketAddress: p.marketAddress,
        question: p.question,
        category: p.category,
        outcomeIdx: p.outcomeIdx,
        outcomeLabel: p.outcomeLabel,
        shares: sharesToFloat(p.shares),
        costBasisTokens: tokensToFloat(p.costBasisTokens),
        currentImpliedProb: p.currentImpliedProb,
        status: p.status,
      })),
      totalCostBasisTokens: tokensToFloat(totalCost),
      tradeCount: this.state.trades.length,
      recentTrades: this.state.trades.slice(-25).reverse().map((t) => ({
        timestamp: t.timestamp,
        marketAddress: t.marketAddress,
        question: t.question.slice(0, 80),
        side: t.side,
        outcomeLabel: t.outcomeLabel,
        shares: t.shares !== null ? sharesToFloat(t.shares) : null,
        tokens: t.tokens !== null ? tokensToFloat(t.tokens) : null,
        txHash: t.txHash,
        status: t.status,
        note: t.note,
      })),
    };
  }
}
