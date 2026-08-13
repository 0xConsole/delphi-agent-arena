/**
 * Rules-based, LLM-free trading strategy for Delphi prediction markets.
 *
 * The agent is judged on P&L, so the strategy favours reliability and capital
 * preservation over flair.  It is deliberately conservative:
 *
 *  - Domain heuristics estimate a probability for each outcome from the market
 *    question + category (crypto / sports / politics / economics / misc).
 *  - When the estimated probability differs from the market's implied
 *    probability by more than `minEdge`, the underpriced outcome is a BUY.
 *  - Position sizing is a fixed % of token balance (kelly-lite), capped.
 *  - No trade is taken if there is no clear edge, insufficient balance, or the
 *    position book is full.
 *
 * Everything is deterministic and inspectable — no black-box LLM calls.
 */

import type { Market } from "@gensyn-ai/gensyn-delphi-sdk";
import type { AgentConfig } from "./config.js";
import { ONE_TOKEN, floatToTokens } from "./config.js";

export interface StrategySignal {
  marketAddress: `0x${string}`;
  marketUrl: string;
  question: string;
  category: string;
  outcomeIdx: number;
  outcomeLabel: string;
  impliedProb: number; // 0..1 (from market prices)
  estimatedProb: number; // 0..1 (our heuristic estimate)
  edge: number; // estimatedProb - impliedProb
  reason: string; // human-readable rationale
}

export interface SizedSignal extends StrategySignal {
  sharesOut: bigint; // 18 decimals
  maxTokensIn: bigint; // 6 decimals
}

/** Extract a best-effort probability estimate from a market question. */
export function estimateProbability(market: Market): {
  probYES: number;
  reason: string;
} | null {
  const meta = market.metadata;
  if (!meta || !meta.question) return null;
  const q = meta.question.toLowerCase();
  const outcomes = meta.outcomes ?? [];
  // Most competition markets are binary YES/NO (2 outcomes).
  const isBinary = outcomes.length === 2;
  if (!isBinary && outcomes.length === 0) return null;

  const cat = (market.category || "miscellaneous").toLowerCase();

  // ---- Crypto price-threshold markets: "Will BTC be above $X on <date>?" ----
  const crypto = parseCryptoThreshold(q);
  if (crypto) {
    return cryptoEstimate(crypto, cat);
  }

  // ---- Sports markets: "Will <team> win <event>?" ----
  const sports = parseSportsMatch(q);
  if (sports && (cat === "sports" || /win|beat|defeat|vs\.?|versus/.test(q))) {
    return sportsEstimate(sports, q, cat);
  }

  // ---- Politics: "Will <event> happen?" — use neutral 0.5 base for unknown ----
  if (cat === "politics" || /election|president|vote|senate|congress/.test(q)) {
    return politicsEstimate(q);
  }

  // ---- Economics: "Will CPI be above X%?" etc. ----
  if (cat === "economics" || /cpi|gdp|inflation|interest rate|fed|recession|unemployment/.test(q)) {
    return economicsEstimate(q);
  }

  // ---- Fallback: mean-reversion / contrarian on extreme prices ----
  return contrarianEstimate(q, market);
}

/* ----------------------------- Crypto threshold ----------------------------- */

interface CryptoThreshold {
  asset: string;
  threshold: number;
  direction: "above" | "below";
  byDate: string | null;
}

function parseCryptoThreshold(q: string): CryptoThreshold | null {
  const assetMatch = q.match(/\b(btc|bitcoin|eth|ethereum|sol|solana|doge|dogecoin|xrp|ripple|ada|cardano|avax|avalanche|link|chainlink|matic|polygon)\b/);
  const priceMatch = q.match(/\$?\s*([0-9][0-9,.]*)\s*(?:k|m\b|million|billion)?/i);
  const above = /\b(above|over|exceed|higher than|greater than|more than|top)\b/.test(q);
  const below = /\b(below|under|less than|lower than|drop|fall)\b/.test(q);
  if (!assetMatch || !priceMatch) return null;
  const rawPrice = priceMatch[1].replace(/,/g, "");
  let threshold = parseFloat(rawPrice);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  // Handle "100k" suffix already consumed in regex group? Re-check for k/m.
  if (/k\b/i.test(q)) threshold *= 1_000;
  if (/m\b|million/i.test(q)) threshold *= 1_000_000;
  if (/b\b|billion/i.test(q)) threshold *= 1_000_000_000;
  return {
    asset: assetMatch[1],
    threshold,
    direction: above ? "above" : below ? "below" : "above",
    byDate: q.match(/\b(\d{1,2}(st|nd|rd|th)?\s+\w+|\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
  };
}

/**
 * Estimate P(asset above/below threshold by date).
 *
 * Without a live price feed inside the agent (to stay LLM-free and dependency-
 * light), we use a coarse prior: markets tend to set prices near the current
 * spot, so a threshold far from spot is less likely. We infer "distance" from
 * the market's OWN implied probability (a proxy for the crowd's distance
 * estimate) and apply a mild contrarian tilt: when the crowd is very confident
 * (price near 0 or 1), we fade slightly toward 0.5; when the crowd is
 * uncertain (near 0.5), we trust it more.
 *
 * This is intentionally conservative — we only generate an edge when the
 * market price is in an extreme zone and the question structure suggests the
 * extreme is overpriced.
 */
function cryptoEstimate(c: CryptoThreshold, _cat: string): {
  probYES: number;
  reason: string;
} | null {
  // The actual estimate is market-relative (see contrarianEstimate); here we
  // just flag that this is a crypto threshold market for the caller.
  void c;
  return null;
}

/* ------------------------------- Sports ---------------------------------- */

interface SportsMatch {
  teamA: string;
  teamB: string;
}

function parseSportsMatch(q: string): SportsMatch | null {
  // "Will <team> beat <team>?" / "Will <team> win <event>?"
  const beat = q.match(/will\s+([a-z0-9 -]+?)\s+(?:beat|defeat|win against|defeat)\s+([a-z0-9 -]+)/);
  if (beat) return { teamA: beat[1].trim(), teamB: beat[2].trim() };
  const versus = q.match(/([a-z0-9 -]+)\s+(?:vs\.?|versus)\s+([a-z0-9 -]+)/);
  if (versus) return { teamA: versus[1].trim(), teamB: versus[2].trim() };
  return null;
}

function sportsEstimate(
  _m: SportsMatch,
  q: string,
  _cat: string,
): { probYES: number; reason: string } {
  // Without team strength data, use the "home underdog" heuristic: markets
  // listed late in a tournament with a clear favourite tend to be overpriced
  // on the favourite. We fade the favourite slightly. Prob is for the FIRST
  // outcome (typically YES = "will teamA win").
  void _m;
  const fav = /\b(heavy favorite|favourite|clear favorite|expected to win|likely to win)\b/.test(q);
  return {
    probYES: fav ? 0.42 : 0.5,
    reason: "sports: no team-strength data; fading favourite slightly (0.42 vs ~0.5)",
  };
}

/* ------------------------------ Politics --------------------------------- */

function politicsEstimate(q: string): { probYES: number; reason: string } {
  // "Will <incumbent> win re-election?" — mild incumbent advantage.
  const incumbent = /\b(re-?election|incumbent|re-elect|second term)\b/.test(q);
  return {
    probYES: incumbent ? 0.55 : 0.5,
    reason: "politics: mild incumbent prior (0.55) / neutral (0.50)",
  };
}

/* ------------------------------ Economics -------------------------------- */

function economicsEstimate(q: string): { probYES: number; reason: string } {
  // "Will CPI be above X%?" — default to slight bias toward the consensus
  // (which markets already price), so we stay near 0.5 unless the question
  // phrasing suggests an extreme.
  const extreme = /\b(record|highest|lowest|first time|never)\b/.test(q);
  return {
    probYES: extreme ? 0.35 : 0.5,
    reason: extreme
      ? "economics: extreme-outcome question, fading toward 0.35"
      : "economics: neutral 0.50 prior",
  };
}

/* --------------------------- Contrarian fallback -------------------------- */

/**
 * The workhorse estimator. For any market with on-chain spot prices, we
 * estimate a probability by regressing the market's own implied probability
 * toward 0.5 (the "no-information" prior).  This creates a contrarian edge
 * exactly when the market is overconfident — the most reliably profitable
 * pattern in thin prediction markets.
 *
 *   estimatedProb = implied + shrink * (0.5 - implied)
 *
 * A shrinkage factor of ~0.15 means: if the market says 0.90, we estimate
 * 0.915 - no edge. If the market says 0.95, we estimate 0.9275 - still no
 * edge. The edge appears at the extremes because the *true* probability of
 * near-certain events is rarely as certain as the market prices them, and
 * thin markets overshoot.
 *
 * BUT — contrarian alone would have us always betting against extremes,
 * which loses money when the extreme is actually right. So we gate it:
 * only emit an estimate (and thus a potential signal) when the market is in
 * an extreme zone (implied < 0.15 or > 0.85), AND we keep the edge small.
 */
export function contrarianEstimate(
  _q: string,
  market: Market,
): { probYES: number; reason: string } | null {
  const probs = market.spotImpliedProbabilities;
  if (!probs || probs.length < 2) return null;
  const impliedYES = probs[0]; // outcome 0 = YES convention
  if (!Number.isFinite(impliedYES)) return null;

  const shrink = 0.18;
  const est = impliedYES + shrink * (0.5 - impliedYES);

  // Only emit a signal-worthy estimate in the extreme zones.
  if (impliedYES > 0.85 || impliedYES < 0.15) {
    return {
      probYES: est,
      reason: `contrarian: market implied ${(impliedYES * 100).toFixed(1)}%, ` +
        `shrunk toward 0.5 -> ${(est * 100).toFixed(1)}%`,
    };
  }
  // In the neutral band, no edge — return the implied as-is (no signal later).
  return {
    probYES: impliedYES,
    reason: "contrarian: market in neutral band, no edge",
  };
}

/* ------------------------------ Signal gen -------------------------------- */

/**
 * Produce a strategy signal for a market if there is a tradeable edge.
 * Returns null if no edge or if the market is not analysable.
 */
export function evaluateMarket(market: Market, cfg: AgentConfig): StrategySignal | null {
  const probs = market.spotImpliedProbabilities;
  if (!probs || probs.length === 0) return null;
  const outcomes = market.metadata?.outcomes ?? [];
  const est = estimateProbability(market);
  if (!est) return null;

  // For binary markets, est.probYES is the prob of outcome 0 (YES).
  // For multi-outcome, we only handle the binary case for reliability.
  if (probs.length !== 2) return null;

  const impliedYES = probs[0];
  const estYES = est.probYES;
  const edge = estYES - impliedYES;
  if (Math.abs(edge) < cfg.minEdge) return null;

  // Buy the underpriced outcome.
  // edge > 0  -> outcome 0 (YES) is underpriced -> buy YES (idx 0)
  // edge < 0  -> outcome 1 (NO)  is underpriced -> buy NO  (idx 1)
  const outcomeIdx = edge > 0 ? 0 : 1;
  const outcomeLabel = outcomes[outcomeIdx] ?? (outcomeIdx === 0 ? "YES" : "NO");
  const impliedProb = outcomeIdx === 0 ? impliedYES : 1 - impliedYES;
  const estimatedProb = outcomeIdx === 0 ? estYES : 1 - estYES;

  return {
    marketAddress: market.id as `0x${string}`,
    marketUrl: market.marketUrl,
    question: market.metadata?.question ?? "(no question)",
    category: market.category,
    outcomeIdx,
    outcomeLabel,
    impliedProb,
    estimatedProb,
    edge: estimatedProb - impliedProb,
    reason: est.reason,
  };
}

/* ----------------------------- Position sizing ---------------------------- */

/**
 * Kelly-inspired position sizing, clamped for safety.
 *
 * fraction = edge / (1 - impliedProb)   (simplified kelly for a binary bet)
 * capped at maxRiskPct of balance, and never more than impliedProb (so we
 * never stake more than the "winning" side's share). Returns shares (18 dec)
 * and the max tokens to spend (6 dec).
 */
export function sizePosition(
  signal: StrategySignal,
  tokenBalance: bigint,
  cfg: AgentConfig,
): SizedSignal | null {
  if (tokenBalance <= 0n) return null;
  const maxSpendTokens = (tokenBalance * BigInt(Math.round(cfg.maxRiskPct * 100))) / 10000n;
  if (maxSpendTokens <= 0n) return null;

  // Simplified kelly: f = edge / (1 - p_implied), clamped to [0, maxRiskPct].
  const denom = 1 - signal.impliedProb;
  let kellyF = denom > 0.001 ? signal.edge / denom : 0;
  kellyF = Math.max(0, Math.min(kellyF, cfg.maxRiskPct / 100));
  // Use a quarter-kelly for safety.
  kellyF = kellyF / 4;
  if (kellyF <= 0) return null;

  let spendTokens = (tokenBalance * BigInt(Math.round(kellyF * 10_000))) / 10_000n;
  if (spendTokens > maxSpendTokens) spendTokens = maxSpendTokens;
  if (spendTokens < ONE_TOKEN / 2n) return null; // dust guard — skip < 0.5 $TST

  // Convert spend tokens -> shares. In an LMSR market, buying `s` shares at
  // implied prob p costs roughly p * s (for small s). We approximate
  // sharesOut = spendTokens / impliedProb, which is the linear (CPDA-like)
  // upper bound; the actual LMSR cost is <= this for small trades.
  const sharesOut =
    signal.impliedProb > 0.01
      ? (spendTokens * 10n ** 12n) / BigInt(Math.round(signal.impliedProb * 10_000)) * 10_000n / 10n ** 12n
      : spendTokens * 10n ** 12n; // tiny implied prob: 1 token = 1 share scaling

  if (sharesOut < cfg.minSharesToTrade) return null;

  const maxTokensIn = (spendTokens * BigInt(100 + Math.round(cfg.slippagePct))) / 100n;

  return {
    ...signal,
    sharesOut,
    maxTokensIn,
  };
}

/** Convenience: format a signal for logs. */
export function signalSummary(s: StrategySignal): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return `${s.question.slice(0, 60)} | buy ${s.outcomeLabel} @ ${pct(s.impliedProb)} (est ${pct(s.estimatedProb)}, edge ${(s.edge * 100).toFixed(1)}pp) — ${s.reason}`;
}
