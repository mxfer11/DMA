// Server-side: your API key never reaches the browser.
const KEY = process.env.FMP_API_KEY;
const BASE = "https://financialmodelingprep.com/stable";
const DAY = 24 * 3600 * 1000, WEEK = 7 * DAY;
// Updates every Saturday at 12:00 UTC (after Friday's close). To change the day, change this date to any Saturday.
const ANCHOR = Date.UTC(2026, 9, 17, 12, 0, 0);
function period(now = Date.now()) {
  const id = Math.floor((now - ANCHOR) / WEEK);
  return { id, next: ANCHOR + (id + 1) * WEEK };
}

// Edit this list to change which companies are screened.
const UNIVERSE = {
  AAPL:"Apple", MSFT:"Microsoft", GOOGL:"Alphabet", AMZN:"Amazon", META:"Meta", NVDA:"Nvidia",
  AVGO:"Broadcom", JPM:"JPMorgan Chase", V:"Visa", MA:"Mastercard", WMT:"Walmart", COST:"Costco",
  HD:"Home Depot", PG:"Procter & Gamble", JNJ:"Johnson & Johnson", UNH:"UnitedHealth", XOM:"Exxon Mobil",
  KO:"Coca-Cola", PEP:"PepsiCo", LLY:"Eli Lilly", ABBV:"AbbVie", MRK:"Merck", ORCL:"Oracle",
  ADBE:"Adobe", CSCO:"Cisco", TXN:"Texas Instruments", NFLX:"Netflix", TSLA:"Tesla", NKE:"Nike", DIS:"Disney"
};

let cache = { id: null, body: null };   // full result, refreshed once per weekly period
const profit = {};                  // symbol -> { t, netIncome }, re-checked only monthly

async function api(path, params) {
  const q = new URLSearchParams({ ...params, apikey: KEY });
  const r = await fetch(`${BASE}/${path}?${q}`);
  let j = null; try { j = await r.json(); } catch {}
  const msg = j && !Array.isArray(j) && (j["Error Message"] || j.message);
  if (r.status === 429 || r.status === 401 || (msg && /limit|invalid api|exceed/i.test(msg))) {
    const e = new Error(msg || `Key or limit problem (${r.status})`); e.fatal = true; throw e;
  }
  if (!r.ok || msg) throw new Error(msg || `${path} ${r.status}`);
  return j;
}

async function one(symbol) {
  let p = profit[symbol];
  if (!p || Date.now() - p.t > 30 * DAY) {                 // profit rarely changes: check once a month
    const inc = await api("income-statement", { symbol, limit: 1 });
    p = profit[symbol] = { t: Date.now(), netIncome: inc && inc[0] && inc[0].netIncome };
  }
  if (!(p.netIncome > 0)) return null;                     // profitable companies only
  const rows = await api("historical-price-eod/full", { symbol });
  if (!Array.isArray(rows) || rows.length < 260) return null;
  const r = rows.slice(0, 1100).reverse();
  return { symbol, name: UNIVERSE[symbol], netIncome: p.netIncome,
           dates: r.map(x => x.date), closes: r.map(x => +Number(x.close).toFixed(2)) };
}

function send(res, body, seconds) {
  // The CDN keeps this until the next update, so most visits cost zero API calls.
  seconds = Math.max(60, Math.floor(seconds));
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${seconds}`);
  res.status(200).json(body);
}

module.exports = async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "FMP_API_KEY is not set on the server." });
  const per = period(), left = (per.next - Date.now()) / 1000;
  if (cache.body && cache.id === per.id) return send(res, cache.body, left);

  const symbols = Object.keys(UNIVERSE), out = []; let fatal = null;
  for (let i = 0; i < symbols.length && !fatal; i += 6) {   // stop early if the limit is hit
    const batch = await Promise.allSettled(symbols.slice(i, i + 6).map(one));
    batch.forEach(b => {
      if (b.status === "fulfilled" && b.value) out.push(b.value);
      else if (b.status === "rejected" && b.reason && b.reason.fatal) fatal = b.reason.message;
    });
  }
  if (fatal) {
    if (cache.body) return send(res, cache.body, 3600);     // keep showing yesterday's data
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "FMP says: " + fatal });
  }
  if (!out.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "No data returned. Check your API key and plan." });
  }
  cache = { id: per.id, body: { updated: new Date().toISOString(), next: new Date(per.next).toISOString(), stocks: out } };
  send(res, cache.body, left);
};
