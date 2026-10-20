// Runs once a week on GitHub (free). Fetches data from FMP and saves it to public/stocks.json.
// Visitors only ever read that file, so they can never use up your API calls.
const fs = require("fs");
const KEY = process.env.FMP_API_KEY;
const BASE = "https://financialmodelingprep.com/stable";
const FILE = "public/stocks.json";
const DAY = 86400000;

// Edit this list to change which companies are screened.
const UNIVERSE = {
  AAPL:"Apple", MSFT:"Microsoft", GOOGL:"Alphabet", AMZN:"Amazon", META:"Meta", NVDA:"Nvidia",
  AVGO:"Broadcom", JPM:"JPMorgan Chase", V:"Visa", MA:"Mastercard", WMT:"Walmart", COST:"Costco",
  HD:"Home Depot", PG:"Procter & Gamble", JNJ:"Johnson & Johnson", UNH:"UnitedHealth", XOM:"Exxon Mobil",
  KO:"Coca-Cola", PEP:"PepsiCo", LLY:"Eli Lilly", ABBV:"AbbVie", MRK:"Merck", ORCL:"Oracle",
  ADBE:"Adobe", CSCO:"Cisco", TXN:"Texas Instruments", NFLX:"Netflix", TSLA:"Tesla", NKE:"Nike", DIS:"Disney"
};

function nextSaturday() {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 6);
  return d.toISOString();
}

async function api(path, params) {
  const q = new URLSearchParams({ ...params, apikey: KEY });
  let r;
  try { r = await fetch(`${BASE}/${path}?${q}`); }
  catch (e) { const x = new Error("network: " + e.message); x.kind = "retry"; throw x; }
  let j = null; try { j = await r.json(); } catch {}
  const msg = j && !Array.isArray(j) && (j["Error Message"] || j.message);
  const fail = (kind, m) => { const x = new Error(m); x.kind = kind; throw x; };
  if (r.status === 429 || r.status === 401 || (msg && /limit|invalid api|exceed/i.test(msg))) fail("fatal", msg || `limit or key problem (${r.status})`);
  if ([400, 402, 403, 404].includes(r.status) || msg) fail("skip", msg || `not available on your plan (${r.status})`);
  if (!r.ok) fail("retry", `${path} ${r.status}`);
  return j;
}

(async () => {
  if (!KEY) { console.error("The FMP_API_KEY secret is missing in GitHub."); process.exit(1); }
  let old = { stocks: [], profit: {}, skipped: [] };
  try { old = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  const oldBy = Object.fromEntries((old.stocks || []).map(s => [s.symbol, s]));
  const profit = old.profit || {}, skipped = new Set(old.skipped || []);
  const out = []; let stop = null, calls = 0;

  for (const symbol of Object.keys(UNIVERSE)) {
    if (skipped.has(symbol)) continue;                       // stocks your plan can't read are never retried
    if (stop) { if (oldBy[symbol]) out.push(oldBy[symbol]); continue; }
    try {
      let p = profit[symbol];
      if (!p || Date.now() - p.t > 30 * DAY) {                // profit is re-checked about once a month
        const inc = await api("income-statement", { symbol, limit: 1 }); calls++;
        p = profit[symbol] = { t: Date.now(), netIncome: inc && inc[0] && inc[0].netIncome };
      }
      if (!(p.netIncome > 0)) continue;                       // profitable companies only
      const from = new Date(Date.now() - 1700 * DAY).toISOString().slice(0, 10);   // about 4.6 years
      const rows = await api("historical-price-eod/full", { symbol, from }); calls++;
      if (!Array.isArray(rows) || rows.length < 260) { if (oldBy[symbol]) out.push(oldBy[symbol]); continue; }
      const r = rows.slice(0, 1100).reverse();
      out.push({ symbol, name: UNIVERSE[symbol], netIncome: p.netIncome,
        dates: r.map(x => x.date), closes: r.map(x => +Number(x.close).toFixed(2)) });
    } catch (e) {
      console.log(`${symbol}: ${e.message}`);
      if (e.kind === "fatal") { stop = e.message; if (oldBy[symbol]) out.push(oldBy[symbol]); }
      else if (e.kind === "skip") skipped.add(symbol);
      else if (oldBy[symbol]) out.push(oldBy[symbol]);
    }
  }

  if (!out.length) { console.error("No stock data was saved. " + (stop || "Check your key and plan.")); process.exit(1); }
  const result = { updated: stop && old.updated ? old.updated : new Date().toISOString(),
                   next: nextSaturday(), stocks: out, profit, skipped: [...skipped] };
  fs.writeFileSync(FILE, JSON.stringify(result));
  console.log(`Saved ${out.length} stocks using ${calls} calls.` + (stop ? ` Stopped early (${stop}); older prices kept for the rest.` : ""));
})();
