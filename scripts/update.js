// Runs once a week on GitHub (free). Fetches data from FMP and saves it to public/stocks.json.
// Visitors only ever read that file, so they can never use up your API calls.
const fs = require("fs");
const KEY = process.env.FMP_API_KEY;
const BASE = "https://financialmodelingprep.com/stable";
const FILE = "public/stocks.json";
const DAY = 86400000;

// ---------------- YOUR QUALITY FILTERS (change these numbers any time) ----------------
const MIN_PROFIT_YEARS = 4;   // net income must be above zero in EACH of the last N yearly reports
const MIN_MARGIN = 0.05;      // latest year: net income / revenue must be at least 5% (use 0 to switch off)
const MAX_PE = 40;            // price / latest yearly earnings per share must be at most 40 ("not hyped"; use 9999 to switch off)
const EXCLUDE = [];           // stocks you never want, for example ["TSLA", "NFLX"]
// --------------------------------------------------------------------------------------

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

// turns FMP's yearly income statements into a simple list, newest year first
function toRows(inc) {
  return (Array.isArray(inc) ? inc : []).slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map(x => ({
      y: x.fiscalYear || String(x.date).slice(0, 4), ni: x.netIncome, rev: x.revenue,
      eps: x.epsDiluted ?? x.eps ?? (x.weightedAverageShsOutDil ? x.netIncome / x.weightedAverageShsOutDil : null)
    }));
}

// returns a reason text if the company fails the profit and margin rules, otherwise null
function whyNot(rows) {
  if (rows.length < MIN_PROFIT_YEARS) return `only ${rows.length} yearly report(s) available, need ${MIN_PROFIT_YEARS}`;
  const loss = rows.slice(0, MIN_PROFIT_YEARS).find(r => !(r.ni > 0));
  if (loss) return `not profitable in ${loss.y}`;
  const m = rows[0].rev > 0 ? rows[0].ni / rows[0].rev : null;
  if (m !== null && m < MIN_MARGIN) return `profit margin ${(m * 100).toFixed(1)}% is under ${MIN_MARGIN * 100}%`;
  return null;
}

(async () => {
  if (!KEY) { console.error("The FMP_API_KEY secret is missing in GitHub."); process.exit(1); }
  let old = { stocks: [], profit: {}, skipped: [] };
  try { old = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  const oldBy = Object.fromEntries((old.stocks || []).map(s => [s.symbol, s]));
  const profit = old.profit || {}, skipped = new Set(old.skipped || []);
  const out = [], rejected = {}; let stop = null, calls = 0;

  for (const symbol of Object.keys(UNIVERSE)) {
    if (EXCLUDE.includes(symbol)) { rejected[symbol] = "on your exclude list"; continue; }
    if (skipped.has(symbol)) continue;                       // stocks your plan can't read are never retried
    if (stop) { if (oldBy[symbol]) out.push(oldBy[symbol]); continue; }
    try {
      let p = profit[symbol];
      if (!p || !p.rows || Date.now() - p.t > 30 * DAY) {     // yearly reports are re-checked about once a month
        const inc = await api("income-statement", { symbol, limit: Math.max(MIN_PROFIT_YEARS, 1) }); calls++;
        p = profit[symbol] = { t: Date.now(), rows: toRows(inc) };
      }
      const why = whyNot(p.rows);
      if (why) { rejected[symbol] = why; console.log(`${symbol}: left out, ${why}`); continue; }

      const from = new Date(Date.now() - 1700 * DAY).toISOString().slice(0, 10);   // about 4.6 years
      const rows = await api("historical-price-eod/full", { symbol, from }); calls++;
      if (!Array.isArray(rows) || rows.length < 260) { if (oldBy[symbol]) out.push(oldBy[symbol]); continue; }
      const px = rows.slice(0, 1100).reverse();
      const closes = px.map(x => +Number(x.close).toFixed(2)), dates = px.map(x => x.date);

      const eps = p.rows[0].eps, pe = eps > 0 ? closes[closes.length - 1] / eps : null;
      if (pe !== null && pe > MAX_PE) { rejected[symbol] = `price is ${pe.toFixed(0)} times yearly earnings, over ${MAX_PE}`; console.log(`${symbol}: left out, ${rejected[symbol]}`); continue; }
      if (pe === null) console.log(`${symbol}: P/E unknown, kept`);

      out.push({ symbol, name: UNIVERSE[symbol], netIncome: p.rows[0].ni,
        margin: p.rows[0].rev > 0 ? +(p.rows[0].ni / p.rows[0].rev).toFixed(3) : null,
        pe: pe === null ? null : +pe.toFixed(1), dates, closes });
    } catch (e) {
      console.log(`${symbol}: ${e.message}`);
      if (e.kind === "fatal") { stop = e.message; if (oldBy[symbol]) out.push(oldBy[symbol]); }
      else if (e.kind === "skip") skipped.add(symbol);
      else if (oldBy[symbol]) out.push(oldBy[symbol]);
    }
  }

  if (!out.length) {
    const few = Object.values(rejected).filter(r => r.startsWith("only ")).length;
    if (few && few >= Object.keys(rejected).length * 0.8) console.error(`Your FMP plan seems to return fewer than ${MIN_PROFIT_YEARS} yearly reports. Set MIN_PROFIT_YEARS to 1 at the top of scripts/update.js and run again.`);
    console.error("No stock data was saved. " + (stop || "Check the reasons above."));
    process.exit(1);
  }
  const filters = `profitable in each of the last ${MIN_PROFIT_YEARS} year${MIN_PROFIT_YEARS === 1 ? "" : "s"}, net margin at least ${Math.round(MIN_MARGIN * 100)}%, price at most ${MAX_PE} times yearly earnings`;
  const result = { updated: stop && old.updated ? old.updated : new Date().toISOString(), next: nextSaturday(),
                   filters, rejected, stocks: out, profit, skipped: [...skipped] };
  fs.writeFileSync(FILE, JSON.stringify(result));
  console.log(`Saved ${out.length} stocks using ${calls} calls. Left out by your filters: ${Object.keys(rejected).length}.` + (stop ? ` Stopped early (${stop}); older prices kept for the rest.` : ""));
})();
