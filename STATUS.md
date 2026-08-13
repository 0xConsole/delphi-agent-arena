# Delphi Agent Arena — Status

## Registration: ✅ DONE
- DoraHacks hackathon ID: 2320
- BUIDL ID: 47649 (SentinelTrader)
- Submission ID: 53631
- Track: 4565 (Autonomous Trading Agents)
- Registered as hacker: YES

## BLOCKED: Need Testnet ETH + Competition Tokens
- Wallet: 0x3f567c3254E9Dc9C2813E2a8b71BB3604Ba53155
- Gensyn Testnet ETH: 0 (need gas for trades)
- Competition tokens (TST): 0 (auto-funded after wallet allowlisted, may take 24h)
- Sepolia ETH: 0 (can't bridge to Gensyn)
- All faucets require browser/anti-bot (Cloudflare blocked)

## Need: Delphi API Key
- Required for REST API (listMarkets, getMarket, listPositions)
- Must be generated at https://delphi-api-access.gensyn.ai/ via wallet signing
- Wallet signature flow (Privy auth) needs browser with injected provider

## Next Steps (when funded)
1. Get Sepolia ETH → bridge to Gensyn Testnet
2. Generate API key via wallet signing
3. Install Delphi SDK (done: @gensyn-ai/gensyn-delphi-sdk@2.1.0)
4. Build trading agent using SDK
5. Run agent for competition duration (Aug 10-24)

## Timeline
- Trading window: Aug 10 - Aug 24
- Deadline: Aug 23 23:59 UTC
- Prize: $10K (1st $5K, 2nd $3K, 3rd $2K)
- 175 hackers registered, 0 BUIDLs submitted (trading competition)
