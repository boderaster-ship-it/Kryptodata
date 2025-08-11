import {cacheGet, cacheSet, k} from './storage.js';

const CG = 'https://api.coingecko.com/api/v3';
const BN = 'https://api.binance.com';
const AV = 'https://www.alphavantage.co/query';
const PROXY = '/api/proxy'; // optionaler Vercel-Proxy

// Utility
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));

// === Suche ===
export async function searchCrypto(query){
  if(!query?.trim()) return [];
  const url = `${CG}/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url); if(!res.ok) return [];
  const j = await res.json();
  return (j.coins||[]).map(c=>({ type:'crypto', id:c.id, symbol:c.symbol.toUpperCase(), name:c.name }));
}

// AlphaVantage Symbol-Suche (optional)
export async function searchEquity(query, avKey){
  if(!query?.trim()) return [];
  if(avKey){
    const url = `${AV}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${avKey}`;
    const res = await fetch(url); if(res.ok){ const j = await res.json();
      const arr = (j.bestMatches||[]).map(x=>({
        type:'equity',
        symbol: x['1. symbol'],
        name: x['2. name'],
        region: x['4. region'],
        currency: x['8. currency']
      }));
      if(arr.length) return arr;
    }
    // kleine Pause wg. AV-Limit
    await sleep(300);
  }
  // Fallback: Nutzer kennt Ticker -> wir geben einfachen Treffer zurück
  // (z.B. "AAPL", "SPY"). Das echte Validieren erfolgt beim Laden.
  if(/^[A-Z0-9\.\-]{2,10}$/.test(query.toUpperCase())){
    return [{type:'equity', symbol: query.toUpperCase(), name:'(Ticker manuell)'}];
  }
  return [];
}

// === Zeitachsen / Intervalle ===
export function buildBuckets(range, interval){
  const now = Date.now();
  const ranges = { '12h':12*3600e3, '1d':24*3600e3, '7d':7*24*3600e3, '14d':14*24*3600e3, '30d':30*24*3600e3, 'max':3650*24*3600e3 };
  const ivMsMap = {'1m':60e3,'5m':5*60e3,'15m':15*60e3,'1h':3600e3,'4h':4*3600e3,'1d':24*3600e3,'1w':7*24*3600e3};
  const span = ranges[range] ?? ranges['1d'];
  const iv = ivMsMap[interval] ?? ivMsMap['5m'];
  const start = range==='max' ? now - span : now - span;
  const buckets = [];
  for(let t = Math.floor(start/iv)*iv; t<=now; t+=iv){ buckets.push(t); }
  return {buckets, iv};
}

// === Crypto-Preise ===
// CoinGecko market_chart: flexible, aber minutely nur ~1 Tag
async function cgMarket(id, vs='usd', range, interval){
  // Map auf CoinGecko-Intervalle
  const map = (range, iv)=>{
    if (iv==='1d' || iv==='1w') return 'daily';
    if (range==='12h' || range==='1d') return 'minutely';
    if (range==='7d' || range==='14d' || range==='30d') return 'hourly';
    return 'daily';
  };
  const daysMap = { '12h':1, '1d':1, '7d':7, '14d':14, '30d':30, 'max':'max' };
  const days = daysMap[range] ?? 1;
  const intv = map(range, interval);
  const url = `${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${vs}&days=${days}&interval=${intv}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('CoinGecko Fehler');
  const j = await res.json();
  // j.prices: [ [ts, price], ... ]
  return (j.prices||[]).map(p=>({ts:p[0], v:p[1]}));
}

// Binance Klines (nur wenn Symbol vorhanden, z.B. BTCUSDT)
async function binanceKlines(symbol, interval){
  const map = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d','1w':'1w' };
  const iv = map[interval] ?? '5m';
  const limit = 1500; // max
  const url = `${BN}/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Binance Fehler');
  const arr = await res.json();
  return arr.map(k=>({ts:k[0], v: Number(k[4])})); // Close
}

export async function fetchCryptoSeries(sel, settings){
  const key = k({t:'crypto', ids: sel.map(s=>s.id), settings});
  const cached = await cacheGet(key, 5*60e3); // 5 min
  if(cached) return cached;

  const {range, interval} = settings;
  // Für Einfachheit: CoinGecko für alle (stabil & CORS-freundlich). Binance optional möglich.
  const series = [];
  for(const c of sel){
    let s;
    try{
      s = await cgMarket(c.id, 'usd', range, interval);
    }catch(e){ s = []; }
    series.push({ label: `${c.symbol} • ${c.name}`, points: s });
  }
  const res = { kind:'crypto', series };
  await cacheSet(key, res);
  return res;
}

// === Aktien/ETF-Preise ===
async function avTimeSeries(symbol, interval, avKey, range){
  // AV: Intraday (1min..60min) oder DAILY_ADJUSTED
  const intraday = ['1m','5m','15m','1h'].includes(interval);
  if(intraday){
    const map = {'1m':'1min','5m':'5min','15m':'15min','1h':'60min'};
    const iv = map[interval];
    const url = `${AV}?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${iv}&outputsize=full&datatype=json&apikey=${avKey}`;
    const res = await fetch(url); if(!res.ok) throw new Error('AV Intraday Fehler');
    const j = await res.json(); const key = Object.keys(j).find(k=>k.includes('Time Series')); const obj = j[key]||{};
    return Object.entries(obj).map(([ts,o])=>({ts: Date.parse(ts), v: Number(o['4. close'])})).sort((a,b)=>a.ts-b.ts);
  } else {
    const url = `${AV}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${avKey}`;
    const res = await fetch(url); if(!res.ok) throw new Error('AV Daily Fehler');
    const j = await res.json(); const obj = j['Time Series (Daily)']||{};
    return Object.entries(obj).map(([ts,o])=>({ts: Date.parse(ts), v: Number(o['4. close'])})).sort((a,b)=>a.ts-b.ts);
  }
}

async function stooqDaily(symbol){
  // https://stooq.com/q/d/l/?s=aapl&i=d  (CSV)
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}&i=d`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Stooq Fehler');
  const txt = await res.text();
  // CSV: date,open,high,low,close,volume
  const lines = txt.trim().split('\n').slice(1);
  return lines.map(l=>{
    const [d,, , ,close] = l.split(',');
    return {ts: Date.parse(d), v: Number(close)};
  }).sort((a,b)=>a.ts-b.ts);
}

export async function fetchEquitySeries(sel, settings, avKey){
  const key = k({t:'equity', ids: sel.map(s=>s.symbol), settings});
  const cached = await cacheGet(key, 5*60e3);
  if(cached) return cached;

  const {interval} = settings;
  const series = [];
  for(const s of sel){
    let pts=[];
    try{
      if(avKey) pts = await avTimeSeries(s.symbol, interval, avKey, settings.range);
      else pts = await stooqDaily(s.symbol);
    }catch(e){ pts=[]; }
    series.push({ label: `${s.symbol} • ${s.name||''}`, points: pts });
  }
  const res = { kind:'equity', series };
  await cacheSet(key, res);
  return res;
}

// === Harmonisierung auf Buckets ===
export function alignToBuckets(buckets, series){
  // Nearest-neighbor je Bucket
  function nearestVal(points, t){
    if(!points?.length) return null;
    // binäre Suche könnte man optimieren; hier linear fallback (Datensätze sind überschaubar)
    let best=null, bd=1e18;
    for(const p of points){
      const d = Math.abs(p.ts - t);
      if(d<bd){ bd=d; best=p; }
    }
    return best? best.v : null;
  }
  const out = series.map(s=>({
    label: s.label,
    values: buckets.map(t=> nearestVal(s.points, t))
  }));
  return out;
}
