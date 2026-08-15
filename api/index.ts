/**
 * Vercel serverless function — serves the dashboard from /api/index.
 *
 * Because Vercel functions are stateless and short-lived, this endpoint reads
 * the persisted portfolio state (data/portfolio.json written by the agent)
 * and renders the read-only dashboard. The long-running agent loop runs
 * separately (e.g. on a VPS, Railway, or fly.io) and writes portfolio.json.
 *
 * On Vercel, the repo root is the working dir, so data/portfolio.json is
 * read from the repo (keep it gitignored — it's build/runtime state).
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface VercelRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  setHeader: (key: string, value: string | string[]) => VercelResponse;
  end: (body?: string | Buffer) => void;
}

let cachedHtml: string | null = null;

function getHtml(): string {
  if (cachedHtml) return cachedHtml;
  cachedHtml = renderDashboard();
  return cachedHtml;
}

function loadPortfolio(): object {
  const file = join(process.cwd(), "data", "portfolio.json");
  if (!existsSync(file)) {
    return {
      walletAddress: "0x0",
      startedAt: null,
      lastLoopAt: null,
      loops: 0,
      realizedPnlTokens: 0,
      openPositions: [],
      tradeCount: 0,
      recentTrades: [],
      totalCostBasisTokens: 0,
      _note: "No portfolio state yet — the agent may not have run. Run `npm start` to begin trading.",
    };
  }
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // Revive bigints
    const revive = (_k: string, v: unknown) =>
      typeof v === "string" && /^\d{10,}$/.test(v) ? BigInt(v).toString() : v;
    return JSON.parse(raw, revive);
  } catch {
    return { _error: "failed to parse portfolio.json" };
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Health check — lightweight, always-200 JSON probe for uptime monitors.
  if (url.pathname === "/api/health") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);
    return res.end(
      JSON.stringify({
        status: "ok",
        service: "delphi-agent-arena",
        time: new Date().toISOString(),
      }),
    );
  }
  // Portfolio JSON — served for /api and any /api/* (vercel.json rewrites all
  // /api/* to /api/index but preserves the original URL, so match by prefix).
  if (url.pathname === "/api" || url.pathname === "/api/index" || url.pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200);
    return res.end(JSON.stringify(loadPortfolio()));
  }
  // Default: HTML dashboard
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200);
  return res.end(getHtml());
}

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delphi Agent Arena</title>
<style>
  :root{--bg:#0b0e14;--card:#11151f;--border:#1f2733;--text:#e6edf3;--muted:#8b98a9;--accent:#3fb950;--red:#f85149;--blue:#58a6ff}
  *{box-sizing:border-box} body{margin:0;font-family:ui-monospace,Menlo,monospace;background:var(--bg);color:var(--text);padding:24px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:24px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px}
  .card .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .card .value{font-size:20px;margin-top:4px}
  .pos{color:var(--accent)}.neg{color:var(--red)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:normal;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
  td.q{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;background:var(--border);color:var(--muted)}
  .tag.buy{color:var(--accent)}.tag.sell{color:var(--red)}.tag.redeem{color:var(--blue)}.tag.liquidate{color:#d29922}
  a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
  .muted{color:var(--muted)}
</style>
</head>
<body>
<h1>🎯 Delphi Agent Arena</h1>
<div class="muted">autonomous prediction-market trading agent — DoraHacks competition</div>
<div class="grid" id="stats"></div>
<h2>Open Positions</h2>
<table><thead><tr><th>Market</th><th>Outcome</th><th>Shares</th><th>Cost ($TST)</th><th>Implied</th><th>Status</th></tr></thead>
<tbody id="positions"></tbody></table>
<h2>Recent Trades</h2>
<table><thead><tr><th>Time</th><th>Side</th><th>Market</th><th>Outcome</th><th>Shares</th><th>Tokens</th><th>Status</th></tr></thead>
<tbody id="trades"></tbody></table>
<script>
const fmt=n=>(n==null?'-':Number(n).toFixed(n<10?4:2));
const pnl=n=>(n==null?'':n>=0?'pos':'neg');
async function load(){
  try{
    const d=await(await fetch('/api')).json();
    const cards=[
      ['Wallet', d.walletAddress?d.walletAddress.slice(0,10)+'…'+d.walletAddress.slice(-4):'—'],
      ['Realized P&L', fmt(d.realizedPnlTokens), pnl(d.realizedPnlTokens)],
      ['Open Positions', (d.openPositions||[]).length],
      ['Trades', d.tradeCount||0],
      ['Loops', d.loops||0],
      ['Last Loop', d.lastLoopAt?new Date(d.lastLoopAt).toLocaleString():'—'],
    ];
    document.getElementById('stats').innerHTML=cards.map(c=>'<div class="card"><div class="label">'+c[0]+'</div><div class="value '+(c[2]||'')+'">'+c[1]+'</div></div>').join('');
    const ps=d.openPositions||[];
    document.getElementById('positions').innerHTML=ps.map(p=>'<tr><td class="q" title="'+p.question+'">'+p.question+'</td><td>'+p.outcomeLabel+'</td><td>'+fmt(p.shares)+'</td><td>'+fmt(p.costBasisTokens)+'</td><td>'+(p.currentImpliedProb==null?'-':(p.currentImpliedProb*100).toFixed(1)+'%')+'</td><td><span class="tag">'+p.status+'</span></td></tr>').join('')||'<tr><td colspan="6" class="muted">no open positions</td></tr>';
    const ts=d.recentTrades||[];
    document.getElementById('trades').innerHTML=ts.map(t=>'<tr><td class="muted">'+(t.timestamp?new Date(t.timestamp).toLocaleTimeString():'-')+'</td><td><span class="tag '+t.side.toLowerCase()+'">'+t.side+'</span></td><td class="q" title="'+t.question+'">'+t.question+'</td><td>'+t.outcomeLabel+'</td><td>'+fmt(t.shares)+'</td><td>'+fmt(t.tokens)+'</td><td>'+(t.status==='ok'?'✓':'✗')+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">no trades yet</td></tr>';
  }catch(e){document.getElementById('stats').innerHTML='<div class="card">failed to load: '+e+'</div>'}
}
load();setInterval(load,30000);
</script>
</body></html>`;
}
