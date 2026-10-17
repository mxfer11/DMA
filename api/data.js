// Server-side: your API key never reaches the browser.
const KEY = process.env.FMP_API_KEY;
const BASE = "https://financialmodelingprep.com/stable";
const TTL = 12 * 3600 * 1000;

const UNIVERSE = {
  AAPL:"Apple", MSFT:"Microsoft", GOOGL:"Alphabet", AMZN:"Amazon", META:"Meta", NVDA:"Nvidia",
  AVGO:"Broadcom", JPM:"JPMorgan Chase", V:"Visa", MA:"Mastercard", WMT:"Walmart", COST:"Costco",
  HD:"Home Depot", PG:"Procter & Gamble", JNJ:"Johnson & Johnson", UNH:"UnitedHealth", XOM:"Exxon Mobil",
  KO:"Coca-Cola", PEP:"PepsiCo", LLY:"Eli Lilly", ABBV:"AbbVie", MRK:"Merck", ORCL:"Oracle",
  ADBE:"Adobe", CSCO:"Cisco", TXN:"Texas Instruments", NFLX:"Netflix", TSLA:"Tesla", NKE:"Nike", DIS:"Disney"
};

let cache = { t: 0, body: null };

async function api(path, params) {
  const q = new URLSearchParams({ ...params, apikey: KEY });
  const r = await fetch(`${BASE}/${path}?${q}`);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function one(symbol) {
  const inc = await api("income-statement", { symbol, limit: 1 });
  const netIncome = inc && inc[0] && inc[0].netIncome;
  if (!(netIncome > 0)) return null;
  const p = await api("historical-price-eod/full", { symbol });
  if (!Array.isArray(p) || p.length < 260) return null;
  const rows = p.slice(0, 1100).reverse();
  return { symbol, name: UNIVERSE[symbol], netIncome,
           dates: rows.map(r => r.date), closes: rows.map(r => +Number(r.close).toFixed(2)) };
}

module.exports = async (req, res) => {
  if (!KEY) return res.status(500).json({ error: "FMP_API_KEY is not set on the server." });
  if (cache.body && Date.now() - cache.t < TTL) {
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
    return res.status(200).json(cache.body);
  }
  const symbols = Object.keys(UNIVERSE), out = [];
  for (let i = 0; i < symbols.length; i += 6) {
    const batch = await Promise.allSettled(symbols.slice(i, i + 6).map(one));
    batch.forEach(b => { if (b.status === "fulfilled" && b.value) out.push(b.value); });
  }
  if (!out.length) return res.status(502).json({ error: "No data returned. Check your API key and plan limits." });
  cache = { t: Date.now(), body: { updated: new Date().toISOString(), stocks: out } };
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
  res.status(200).json(cache.body);
};
