/**
 * The autonomous trading agent loop.
 *
 * Each cycle:
 *  1. Check balances (ETH for gas, $TST for trading).
 *  2. List open competition markets (with prices + implied probs).
 *  3. For each market, run the strategy → signals.
 *  4. Size & execute the best signals (respecting max positions).
 *  5. Sync on-chain positions.
 *  6. Check settled/expired/failed positions → redeem or liquidate.
 *  7. Record loop, persist portfolio.
 *
 * Runs forever on a timer.  Designed to be safe to interrupt & restart —
 * all state is persisted to data/portfolio.json.
 */

import { Delphi, fmtTokens } from "./delphi.js";
import { Portfolio } from "./portfolio.js";
import { evaluateMarket, sizePosition, signalSummary } from "./strategy.js";
import { tokensToFloat, sharesToFloat } from "./config.js";
import type { AgentConfig } from "./config.js";
import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import { LIQUIDATABLE_MARKET_STATUSES } from "@gensyn-ai/gensyn-delphi-sdk";

export class Agent {
  readonly delphi: Delphi;
  readonly cfg: AgentConfig;
  readonly portfolio: Portfolio;
  walletAddress: string = "";
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.delphi = new Delphi(cfg);
    this.portfolio = new Portfolio("");
  }

  async init(): Promise<void> {
    this.walletAddress = await this.delphi.getAddress();
    // Re-init portfolio with the correct wallet address
    this.portfolio.state.walletAddress = this.walletAddress;
    console.log(`[agent] wallet=${this.walletAddress}`);
    const eth = await this.delphi.getEthBalance();
    const tokens = await this.delphi.getTokenBalance();
    console.log(`[agent] ETH=${fmtTokens(eth * 10n ** 12n)} $TST=${fmtTokens(tokens)}`);
  }

  /** Run one trading cycle. Exposed for testing. */
  async runOnce(): Promise<void> {
    const t0 = Date.now();
    console.log(`\n[agent] === cycle #${this.portfolio.state.loops + 1} @ ${new Date().toISOString()} ===`);

    // 1. Balances
    let tokenBalance: bigint;
    try {
      tokenBalance = await this.delphi.getTokenBalance();
    } catch (err) {
      console.error("[agent] cannot read token balance:", err instanceof Error ? err.message : err);
      return;
    }
    const ethBalance = await this.delphi.getEthBalance().catch(() => 0n);
    console.log(`[agent] balances: ETH=${fmtTokens(ethBalance * 10n ** 12n)} $TST=${fmtTokens(tokenBalance)}`);
    if (ethBalance === 0n) {
      console.warn("[agent] ⚠️  no ETH for gas — fund the wallet with testnet ETH");
    }

    // 2. List open markets
    let markets: Market[];
    try {
      markets = await this.delphi.listOpenMarkets(50);
    } catch (err) {
      console.error("[agent] listMarkets failed:", err instanceof Error ? err.message : err);
      return;
    }
    console.log(`[agent] open markets: ${markets.length}`);

    // 3. Evaluate strategy → signals
    const signals = [];
    for (const m of markets) {
      try {
        const sig = evaluateMarket(m, this.cfg);
        if (sig) signals.push(sig);
      } catch (err) {
        // non-fatal — skip this market
      }
    }
    signals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    console.log(`[agent] signals: ${signals.length}`);
    for (const s of signals.slice(0, 10)) console.log(`  → ${signalSummary(s)}`);

    // 4. Execute — only if we have room and balance
    const openPositionCount = new Set(
      this.portfolio.state.positions.map((p) => p.marketAddress),
    ).size;
    const slots = this.cfg.maxPositions - openPositionCount;
    if (slots <= 0) {
      console.log(`[agent] at max positions (${openPositionCount}/${this.cfg.maxPositions}) — skipping buys`);
    } else {
      let executed = 0;
      // Track markets we've already bought this cycle (avoid double-buy same market)
      const boughtMarkets = new Set<string>();
      for (const sig of signals) {
        if (executed >= slots) break;
        if (boughtMarkets.has(sig.marketAddress)) continue;
        // Skip if we already hold this exact outcome in this market
        const k = `${sig.marketAddress}#${sig.outcomeIdx}`;
        const existingShares = this.portfolio.state.sharesByMarket[k] ?? 0n;
        if (existingShares > 0n) {
          console.log(`  ↑ already holding ${sharesToFloat(existingShares)} shares of ${sig.outcomeLabel} in ${sig.question.slice(0, 40)}`);
          continue;
        }

        const sized = sizePosition(sig, tokenBalance, this.cfg);
        if (!sized) continue;
        console.log(
          `  🔵 BUY ${sig.outcomeLabel} ${sharesToFloat(sized.sharesOut).toFixed(4)} shares, ` +
          `max ${fmtTokens(sized.maxTokensIn)} $TST — ${sig.question.slice(0, 50)}`,
        );
        const res = await this.delphi.buyAtMost(
          sized.marketAddress,
          sized.outcomeIdx,
          sized.sharesOut,
          this.cfg.slippagePct,
        );
        if (res) {
          this.portfolio.recordTrade({
            timestamp: new Date().toISOString(),
            marketAddress: sig.marketAddress,
            question: sig.question,
            category: sig.category,
            outcomeIdx: sig.outcomeIdx,
            outcomeLabel: sig.outcomeLabel,
            side: "BUY",
            shares: res.sharesOut,
            tokens: res.tokensIn,
            txHash: res.tx,
            edge: sig.edge,
            status: "ok",
          });
          tokenBalance -= res.tokensIn; // local bookkeeping
          boughtMarkets.add(sig.marketAddress);
          executed++;
          console.log(`     ✓ tx=${res.tx}`);
        } else {
          this.portfolio.recordTrade({
            timestamp: new Date().toISOString(),
            marketAddress: sig.marketAddress,
            question: sig.question,
            category: sig.category,
            outcomeIdx: sig.outcomeIdx,
            outcomeLabel: sig.outcomeLabel,
            side: "BUY",
            shares: sized.sharesOut,
            tokens: null,
            txHash: null,
            edge: sig.edge,
            status: "error",
            note: "buy failed (see logs)",
          });
        }
      }
      console.log(`[agent] buys executed: ${executed}`);
    }

    // 5. Sync on-chain positions
    await this.syncPositions(markets);

    // 6. Exit settled / expired / failed positions
    await this.exitClosedPositions();

    // 7. Record
    this.portfolio.recordLoop();
    const elapsed = Date.now() - t0;
    console.log(`[agent] cycle done in ${elapsed}ms — realized P&L: ${fmtTokens(this.portfolio.state.realizedPnlTokens)} $TST`);
  }

  /** Pull on-chain positions and reconcile with the portfolio. */
  private async syncPositions(markets: Market[]): Promise<void> {
    try {
      const positions = await this.delphi.listOpenPositions(this.walletAddress);
      const marketsById = new Map<
        string,
        { question: string; category: string; outcomes: string[]; implied: number[] | null }
      >();
      for (const m of markets) {
        marketsById.set(m.id.toLowerCase(), {
          question: m.metadata?.question ?? "(no question)",
          category: m.category,
          outcomes: m.metadata?.outcomes ?? [],
          implied: m.spotImpliedProbabilities ?? null,
        });
      }
      this.portfolio.syncPositions(
        positions.map((p) => ({
          marketProxy: p.marketProxy,
          outcomeIdx: p.outcomeIdx,
          shares: p.shares,
          marketStatus: p.marketStatus,
        })),
        marketsById,
      );
    } catch (err) {
      console.error("[agent] syncPositions failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Redeem winning positions, liquidate expired/failed ones. */
  private async exitClosedPositions(): Promise<void> {
    try {
      const positions = await this.delphi.listOpenPositions(this.walletAddress);
      const byMarket = new Map<string, number[]>();
      const statuses = new Map<string, string>();
      for (const p of positions) {
        const shares = BigInt(p.shares || "0");
        if (shares <= 0n) continue;
        if (p.marketStatus === "settled" || LIQUIDATABLE_MARKET_STATUSES.includes(p.marketStatus)) {
          const idx = Number(p.outcomeIdx);
          const arr = byMarket.get(p.marketProxy) ?? [];
          arr.push(idx);
          byMarket.set(p.marketProxy, arr);
          statuses.set(p.marketProxy, p.marketStatus);
        }
      }
      if (byMarket.size === 0) {
        console.log("[agent] no positions to redeem/liquidate");
        return;
      }
      for (const [marketAddress, indices] of byMarket) {
        const status = statuses.get(marketAddress) ?? "";
        if (status === "settled") {
          console.log(`[agent] 💚 redeeming settled market ${marketAddress}`);
          const r = await this.delphi.redeem(marketAddress as `0x${string}`);
          this.portfolio.recordTrade({
            timestamp: new Date().toISOString(),
            marketAddress,
            question: this.portfolio.state.positions.find((p) => p.marketAddress === marketAddress)?.question ?? "",
            category: "",
            outcomeIdx: -1,
            outcomeLabel: "REDEEM",
            side: "REDEEM",
            shares: r?.sharesIn ?? null,
            tokens: r?.tokensOut ?? null,
            txHash: r?.tx ?? null,
            status: r ? "ok" : "error",
          });
          if (r) console.log(`     ✓ redeemed ${fmtTokens(r.tokensOut)} $TST, tx=${r.tx}`);
        } else if (LIQUIDATABLE_MARKET_STATUSES.includes(status as never)) {
          console.log(`[agent] 🟠 liquidating ${status} market ${marketAddress} indices=${indices.join(",")}`);
          const r = await this.delphi.liquidate(marketAddress as `0x${string}`, indices);
          this.portfolio.recordTrade({
            timestamp: new Date().toISOString(),
            marketAddress,
            question: this.portfolio.state.positions.find((p) => p.marketAddress === marketAddress)?.question ?? "",
            category: "",
            outcomeIdx: -1,
            outcomeLabel: "LIQUIDATE",
            side: "LIQUIDATE",
            shares: null,
            tokens: r?.tokensOut ?? null,
            txHash: r?.tx ?? null,
            status: r ? "ok" : "error",
          });
          if (r) console.log(`     ✓ liquidated ${fmtTokens(r.tokensOut)} $TST, tx=${r.tx}`);
        }
      }
    } catch (err) {
      console.error("[agent] exitClosedPositions failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Start the perpetual loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.init();
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (err) {
        console.error("[agent] uncaught error in cycle:", err instanceof Error ? err.message : err);
      }
      if (this.running) {
        this.loopTimer = setTimeout(loop, this.cfg.loopIntervalMs);
      }
    };
    await loop();
  }

  stop(): void {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }
}
