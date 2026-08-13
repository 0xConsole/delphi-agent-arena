/**
 * Minimal HTTP dashboard server (Node built-in http — no Express dependency).
 *
 * Endpoints:
 *   GET /            — HTML dashboard (renders portfolio + trades)
 *   GET /health      — { status: "ok" }
 *   GET /status      — agent + wallet status (balances, config, loop info)
 *   GET /positions   — current open positions
 *   GET /trades      — trade history
 *   GET /api         — full JSON snapshot (the data the HTML page consumes)
 *
 * Designed to be deployed as a Vercel serverless function (see /api/index.ts)
 * OR run standalone as a long-lived process (`npm run dashboard`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agent.js";
import { fmtTokens } from "../delphi.js";

const HTML_PAGE = renderHtmlShell();

export function createDashboard(agent: Agent, port: number): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;
    try {
      if (path === "/health") return json(res, 200, { status: "ok" });
      if (path === "/api" || path === "/api/index") return json(res, 200, agent.portfolio.snapshot());
      if (path === "/status") return json(res, 200, await statusJson(agent));
      if (path === "/positions") return json(res, 200, agent.portfolio.state.positions.map(pos => ({
        marketAddress: pos.marketAddress,
        question: pos.question,
        category: pos.category,
        outcomeIdx: pos.outcomeIdx,
        outcomeLabel: pos.outcomeLabel,
        shares: Number(pos.shares) / 1e18,
        costBasisTokens: Number(pos.costBasisTokens) / 1e6,
        currentImpliedProb: pos.currentImpliedProb,
        status: pos.status,
      })));
      if (path === "/trades") return json(res, 200, agent.portfolio.state.trades.slice(-100).reverse().map(t => ({
        ...t,
        shares: t.shares !== null ? t.shares.toString() : null,
        tokens: t.tokens !== null ? t.tokens.toString() : null,
      })));
      // Default: serve the HTML dashboard
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(HTML_PAGE);
      }
      json(res, 404, { error: "not found", path });
    } catch (err) {
      console.error("[dashboard] error:", err instanceof Error ? err.message : err);
      json(res, 500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, () => {
    console.log(`[dashboard] listening on http://localhost:${port}`);
  });
  return server;
}

async function statusJson(agent: Agent): Promise<object> {
  const eth = await agent.delphi.getEthBalance().catch(() => 0n);
  const tokens = await agent.delphi.getTokenBalance().catch(() => 0n);
  return {
    agent: "delphi-agent-arena",
    network: agent.cfg.network,
    walletAddress: agent.walletAddress,
    loopIntervalMs: agent.cfg.loopIntervalMs,
    loops: agent.portfolio.state.loops,
    lastLoopAt: agent.portfolio.state.lastLoopAt,
    startedAt: agent.portfolio.state.startedAt,
    ethBalance: fmtTokens(eth * 10n ** 12n),
    tstBalance: fmtTokens(tokens),
    realizedPnlTokens: Number(agent.portfolio.state.realizedPnlTokens) / 1e6,
    openPositions: agent.portfolio.state.positions.length,
    tradeCount: agent.portfolio.state.trades.length,
    config: {
      maxRiskPct: agent.cfg.maxRiskPct,
      minEdge: agent.cfg.minEdge,
      slippagePct: agent.cfg.slippagePct,
      maxPositions: agent.cfg.maxPositions,
    },
  };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function renderHtmlShell(): string {
  // A single-page dashboard that fetches /api and renders a table.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delphi Agent Arena — Dashboard</title>
<style>
  :root { --bg:#0b0e14; --card:#11151f; --border:#1f2733; --text:#e6edf3; --muted:#8b98a9; --accent:#3fb950; --red:#f85149; --blue:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-monospace, "SF Mono", Menlo, monospace; background:var(--bg); color:var(--text); padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:14px; margin:24px 0 8px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:14px; }
  .card .label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
  .card .value { font-size:20px; margin-top:4px; }
  .pos { color:var(--accent); } .neg { color:var(--red); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:normal; text-transform:uppercase; font-size:10px; letter-spacing:.5px; }
  td.q { max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tag { display:inline-block; padding:2px 6px; border-radius:4px; font-size:10px; background:var(--border); color:var(--muted); }
  .tag.buy{ color:var(--accent); } .tag.sell{ color:var(--red); } .tag.redeem{ color:var(--blue); } .tag.liquidate{ color:#d29922; }
  a { color:var(--blue); text-decoration:none; } a:hover{ text-decoration:underline; }
  .muted { color:var(--muted); }
  #err { color:var(--red); margin-top:12px; }
</style>
</head>
<body>
<h1>🎯 Delphi Agent Arena</h1>
<div class="muted" id="sub">autonomous prediction-market trading agent</div>
<div id="err"></div>
<div class="grid" id="stats"></div>
<h2>Open Positions</h2>
<table><thead><tr><th>Market</th><th>Outcome</th><th>Shares</th><th>Cost ($TST)</th><th>Implied</th><th>Status</th></tr></thead>
<tbody id="positions"></tbody></table>
<h2>Recent Trades</h2>
<table><thead><tr><th>Time</th><th>Side</th><th>Market</th><th>Outcome</th><th>Shares</th><th>Tokens</th><th>Tx</th><th>Status</th></tr></thead>
<tbody id="trades"></tbody></table>
<script>
const fmt = n => (n==null?'-':Number(n).toFixed(n<10?4:2));
const pnlClass = n => (n==null?'':n>=0?'pos':'neg');
async function load(){
  try {
    const res = await fetch('/status');
    const s = await res.json();
    const cards = [
      ['Wallet', s.walletAddress?.slice(0,10)+'…'+s.walletAddress?.slice(-4)],
      ['Network', s.network],
      ['$TST Balance', fmt(s.tstBalance)],
      ['ETH Balance', fmt(s.ethBalance)],
      ['Realized P&L', fmt(s.realizedPnlTokens), pnlClass(s.realizedPnlTokens)],
      ['Open Positions', s.openPositions],
      ['Trades', s.tradeCount],
      ['Loops', s.loops],
      ['Last Loop', s.lastLoopAt ? new Date(s.lastLoopAt).toLocaleString() : '—'],
    ];
    document.getElementById('stats').innerHTML = cards.map(c =>
      '<div class="card"><div class="label">'+c[0]+'</div><div class="value '+(c[2]||'')+'">'+c[1]+'</div></div>').join('');
  } catch(e){ document.getElementById('err').textContent='status fetch failed: '+e; }
  try {
    const r2 = await fetch('/positions');
    const ps = await r2.json();
    document.getElementById('positions').innerHTML = ps.map(p =>
      '<tr><td class="q" title="'+p.question+'">'+p.question+'</td><td>'+p.outcomeLabel+'</td><td>'+fmt(p.shares)+'</td><td>'+fmt(p.costBasisTokens)+'</td><td>'+(p.currentImpliedProb==null?'-':(p.currentImpliedProb*100).toFixed(1)+'%')+'</td><td><span class="tag">'+p.status+'</span></td></tr>'
    ).join('') || '<tr><td colspan="6" class="muted">no open positions</td></tr>';
  } catch(e){}
  try {
    const r3 = await fetch('/trades');
    const ts = await r3.json();
    document.getElementById('trades').innerHTML = ts.map(t =>
      '<tr><td class="muted">'+(t.timestamp?new Date(t.timestamp).toLocaleTimeString():'-')+'</td><td><span class="tag '+t.side.toLowerCase()+'">'+t.side+'</span></td><td class="q" title="'+t.question+'">'+t.question+'</td><td>'+t.outcomeLabel+'</td><td>'+fmt(t.shares)+'</td><td>'+fmt(t.tokens)+'</td><td>'+(t.txHash?'<a href="https://gensyn-testnet.g.alchemy.com/tx/'+t.txHash+'" target="_blank">'+t.txHash.slice(0,8)+'…</a>':'-')+'</td><td>'+(t.status==='ok'?'✓':'✗')+'</td></tr>'
    ).join('') || '<tr><td colspan="8" class="muted">no trades yet</td></tr>';
  } catch(e){}
}
load(); setInterval(load, 30000);
</script>
</body>
</html>`;
}
