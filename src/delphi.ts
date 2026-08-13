/**
 * Thin wrapper around the Gensyn Delphi SDK's `DelphiClient`.
 *
 * Centralises client construction (reading from our AgentConfig), exposes the
 * raw client for advanced use, and provides ergonomic helpers for the
 * operations the agent actually performs: listing competition markets with
 * prices, buying/selling, and redeeming/liquidating.
 */

import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import type {
  DelphiClientConfig,
  Market,
  Position,
  ListMarketsParams,
} from "@gensyn-ai/gensyn-delphi-sdk";
import type { AgentConfig } from "./config.js";
import { ONE_TOKEN } from "./config.js";

export interface OpenMarketsResult {
  markets: Market[];
}

export class Delphi {
  readonly client: DelphiClient;
  readonly cfg: AgentConfig;

  constructor(cfg: AgentConfig) {
    const clientConfig: DelphiClientConfig = {
      network: cfg.network,
      signerType: "private_key",
      apiKey: cfg.apiKey,
    };
    if (cfg.privateKey) clientConfig.privateKey = cfg.privateKey;
    if (cfg.rpcUrl) clientConfig.rpcUrl = cfg.rpcUrl;
    if (cfg.chainId) clientConfig.chainId = cfg.chainId;
    if (cfg.tokenAddress) clientConfig.tokenAddress = cfg.tokenAddress;
    if (cfg.gatewayAddress) clientConfig.gatewayAddress = cfg.gatewayAddress;
    if (cfg.factoryAddress) clientConfig.factoryAddress = cfg.factoryAddress;

    this.client = new DelphiClient(clientConfig);
    this.cfg = cfg;
  }

  /** Wallet address of the configured signer. */
  async getAddress(): Promise<`0x${string}`> {
    const signer = await this.client.getSigner();
    return signer.address;
  }

  /** Service health check — does not require auth. */
  async health(): Promise<string> {
    const { status } = await this.client.health();
    return status;
  }

  /** List open competition markets with on-chain spot prices & implied probabilities. */
  async listOpenMarkets(limit = 50): Promise<Market[]> {
    const params: ListMarketsParams = {
      status: "open",
      limit,
      orderBy: "liquidity",
      pricesAndImpliedProbabilities: true,
    };
    const { markets } = await this.client.listMarkets(params);
    return markets ?? [];
  }

  /** Fetch a single market by on-chain address, with prices. */
  async getMarket(marketAddress: string): Promise<Market | null> {
    const market = await this.client.getMarket({
      id: marketAddress,
      pricesAndImpliedProbabilities: true,
    });
    return market;
  }

  /** Open (non-redeemed) positions for the signer wallet. */
  async listOpenPositions(wallet: string): Promise<Position[]> {
    const { positions } = await this.client.listPositions({
      wallet,
      redeemedOrLiquidated: false,
      limit: 200,
    });
    return positions ?? [];
  }

  /** All positions (including redeemed) for P&L history. */
  async listAllPositions(wallet: string): Promise<Position[]> {
    const { positions } = await this.client.listPositions({
      wallet,
      limit: 500,
    });
    return positions ?? [];
  }

  /** Native ETH balance (wei) for gas. */
  async getEthBalance(): Promise<bigint> {
    return this.client.getEthBalance();
  }

  /** Competition token ($TST) balance (6 decimals). */
  async getTokenBalance(): Promise<bigint> {
    return this.client.getErc20Balance();
  }

  /**
   * Quote a buy, then ensure the gateway has token approval, then buy shares.
   * Returns the transaction hash and the tokens spent, or null on failure.
   */
  async buyAtMost(
    marketAddress: `0x${string}`,
    outcomeIdx: number,
    sharesOut: bigint,
    slippagePct: number,
  ): Promise<{ tx: string; tokensIn: bigint; sharesOut: bigint } | null> {
    try {
      const { tokensIn } = await this.client.quoteBuy({
        marketAddress,
        outcomeIdx,
        sharesOut,
      });
      const maxTokensIn = (tokensIn * BigInt(100 + Math.round(slippagePct))) / 100n;

      // Ensure approval covers the max spend (unlimited approval is the default).
      await this.client.ensureTokenApproval({
        marketAddress,
        minimumAmount: maxTokensIn,
      });

      const { transactionHash } = await this.client.buyShares({
        marketAddress,
        outcomeIdx,
        sharesOut,
        maxTokensIn,
      });
      return { tx: transactionHash, tokensIn, sharesOut };
    } catch (err) {
      console.error(
        `[delphi] buy failed market=${marketAddress} outcome=${outcomeIdx}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Quote a sell, then sell shares. Returns tokens received or null. */
  async sellAtLeast(
    marketAddress: `0x${string}`,
    outcomeIdx: number,
    sharesIn: bigint,
    slippagePct: number,
  ): Promise<{ tx: string; tokensOut: bigint } | null> {
    try {
      const { tokensOut } = await this.client.quoteSell({
        marketAddress,
        outcomeIdx,
        sharesIn,
      });
      const minTokensOut = (tokensOut * BigInt(100 - Math.round(slippagePct))) / 100n;
      const { transactionHash } = await this.client.sellShares({
        marketAddress,
        outcomeIdx,
        sharesIn,
        minTokensOut,
      });
      return { tx: transactionHash, tokensOut };
    } catch (err) {
      console.error(
        `[delphi] sell failed market=${marketAddress} outcome=${outcomeIdx}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Redeem a settled winning position. */
  async redeem(
    marketAddress: `0x${string}`,
  ): Promise<{ tx: string; tokensOut: bigint; sharesIn: bigint } | null> {
    try {
      const r = await this.client.redeemMarket({ marketAddress });
      return { tx: r.transactionHash, tokensOut: r.tokensOut, sharesIn: r.sharesIn };
    } catch (err) {
      console.error(
        `[delphi] redeem failed market=${marketAddress}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Liquidate an expired/failed position across given outcome indices. */
  async liquidate(
    marketAddress: `0x${string}`,
    outcomeIndices: number[],
  ): Promise<{ tx: string; tokensOut: bigint } | null> {
    try {
      const r = await this.client.liquidate({ marketAddress, outcomeIndices });
      return { tx: r.transactionHash, tokensOut: r.totalTokensOut };
    } catch (err) {
      console.error(
        `[delphi] liquidate failed market=${marketAddress}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
}

/** Format a bigint token amount (6 decimals) as a human string. */
export function fmtTokens(amount: bigint): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / ONE_TOKEN;
  const frac = abs % ONE_TOKEN;
  const s = `${whole.toString()}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
  return neg ? `-${s}` : s;
}
