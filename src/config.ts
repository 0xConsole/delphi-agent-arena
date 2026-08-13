/**
 * Centralised configuration for the Delphi Agent Arena trading bot.
 *
 * All values come from environment variables (loaded by dotenv) with sensible
 * defaults for the Gensyn Delphi agent competition.  Network defaults
 * (gateway / factory / token / RPC / chain id) come from the SDK itself when
 * DELPHI_NETWORK=competition-testnet, so we only expose overrides here.
 */

import "dotenv/config";

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} must be a number, got: ${raw}`);
  return n;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${key} must be a number, got: ${raw}`);
  return n;
}

function envStr(key: string, fallback?: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

/** Normalise a private key to the 0x-prefixed form the SDK expects. */
export function normalisePrivateKey(key: string | undefined): `0x${string}` | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export interface AgentConfig {
  // --- SDK / wallet ---
  network: "competition-testnet" | "testnet" | "mainnet";
  privateKey?: `0x${string}`;
  apiKey?: string;
  rpcUrl?: string;
  chainId?: number;
  tokenAddress?: `0x${string}`;
  gatewayAddress?: `0x${string}`;
  factoryAddress?: `0x${string}`;

  // --- Strategy tuning ---
  loopIntervalMs: number;
  maxRiskPct: number; // % of token balance per trade
  minEdge: number; // min |estProb - impliedProb| to act (0..1)
  slippagePct: number; // buy maxTokensIn tolerance in %
  maxPositions: number;
  minSharesToTrade: bigint; // dust threshold (18 decimals)

  // --- Dashboard ---
  dashboardPort: number;
}

export function loadConfig(): AgentConfig {
  const network = (envStr("DELPHI_NETWORK", "competition-testnet") ??
    "competition-testnet") as AgentConfig["network"];

  return {
    network,
    privateKey: normalisePrivateKey(process.env.WALLET_PRIVATE_KEY),
    apiKey: envStr("DELPHI_API_ACCESS_KEY"),
    rpcUrl: envStr("GENSYN_RPC_URL"),
    chainId: envInt("GENSYN_CHAIN_ID", 685685),
    tokenAddress: envStr("DELPHI_TOKEN_ADDRESS") as `0x${string}` | undefined,
    gatewayAddress: envStr("DELPHI_GATEWAY_CONTRACT") as `0x${string}` | undefined,
    factoryAddress: envStr("DELPHI_FACTORY_CONTRACT") as `0x${string}` | undefined,

    loopIntervalMs: envInt("AGENT_LOOP_INTERVAL_MS", 300_000),
    maxRiskPct: envFloat("AGENT_MAX_RISK_PCT", 3),
    minEdge: envFloat("AGENT_MIN_EDGE", 0.08),
    slippagePct: envFloat("AGENT_SLIPPAGE_PCT", 2),
    maxPositions: envInt("AGENT_MAX_POSITIONS", 12),
    minSharesToTrade: BigInt("100000000000000000"), // 0.1 shares (18 decimals)

    dashboardPort: envInt("DASHBOARD_PORT", 3001),
  };
}

/** Decimal helpers — shares are 18 decimals, competition token ($TST) is 6 decimals. */
export const SHARE_DECIMALS = 18;
export const TOKEN_DECIMALS = 6;
export const ONE_SHARE = 10n ** BigInt(SHARE_DECIMALS); // 1e18
export const ONE_TOKEN = 10n ** BigInt(TOKEN_DECIMALS); // 1e6

/** Convert a bigint token amount (6 decimals) to a human float. */
export function tokensToFloat(amount: bigint): number {
  return Number(amount) / Number(ONE_TOKEN);
}

/** Convert a human float to a bigint token amount (6 decimals). */
export function floatToTokens(f: number): bigint {
  return BigInt(Math.round(f * Number(ONE_TOKEN)));
}

/** Convert a bigint shares amount (18 decimals) to a human float. */
export function sharesToFloat(amount: bigint): number {
  return Number(amount) / Number(ONE_SHARE);
}
