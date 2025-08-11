import {cacheGet, cacheSet, k} from './storage.js';

const CG = 'https://api.coingecko.com/api/v3';
const BN = 'https://api.binance.com';
const AV = 'https://www.alphavantage.co/query';
const YF_SEARCH = 'https://query2.finance.yahoo.com/v1/finance/search';
const YF_CHART  = 'https://query2.finance.yahoo.com/v8/finance/chart';
const PROXY = '/api/proxy'; // Vercel-Proxy für CORS

// ---- Helper: Direktzugriff versuchen, bei CORS/Fehler Proxy nutzen
async function fetchMaybe(url, as='json'){
  try{
    const r = await fetch(url);
    if(!r.ok) throw new Error('HTTP '+r.status);
    return as==='json' ? r.json() : r.text();
  }catch(e){
    const r2 = await fetch(`${PROXY}?url=${encodeURIComponent(url)}`);
    if(!r2.ok) throw new Error('Proxy HTTP '+r2.status);
    return as==='json' ? r2.json() : r2.text();
  }
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ---- Suche
export async function searchCrypto(query){
  if(!query?.trim()) return [];
  const url = `${CG}/search?query=${encodeURIComponent(query)}`;
  const j = await fetchMaybe(url, 'json');
  return (j.coins||[]).map(c=>({ type:'crypto', id:c.id, symbol:c.symbol.toUpperCase(), name:c.name }));
}

export async function searchEquity(query, avKey){
  if(!query?.trim()) return [];
  // 1) Yahoo Finance Suche (ohne Key, via Proxy)
  try{
    const url = `${YF_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0`;
    const j = await fetchMaybe(url, 'json');
    const allow = new Set(['EQUITY','ETF','MUTUALFUND','INDEX']);
    const arr = (j.quotes||[])
      .filter(x=> allow.has(x.quoteType))
      .map(x=>({
        type:'equity',
        symbol: x.symbol,
        name: x.shortname || x.longname || x.symbol,
        region: x.exchange || x.exchangeDisplay || '',
        currency: x.currency || ''
      }));
    if(arr.length) return arr;
  }catch(_){}
  // 2) AlphaVantage (optional)
  if(avKey){
    const url = `${AV}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${avKey}`;
    try{
      const j = await fetchMaybe(url, 'json');
      const arr = (j.bestMatches||[]).map(x=>({
        type:'equity',
        symbol: x['1. symbol'],
        name: x['2. name'],
        region: x['4. region'],
        currency: x['8. currency']
      }));
      if(arr.length) return arr;
    }catch(_){}
    await sleep(300);
  }
  // 3) Fallback: akzeptiere manuelle Ticker
  if(/^[A-Z0-9\.\-]{2,12}$/.test(query.toUpperCase())){
    return [{type:'equity', symbol: query.toUpperCase(), name:'(Ticker manuell)'}];
  }
  return [];
}

// ---- Zeitachsen / Intervalle
export function buildBuckets(range, interval){
  const now = Date.now();
  const ranges = { '12h':12*3600e3, '1d':24*3600e3, '7d':7*24*3600e3, '14d':14*24*3600e3, '30d':30*24*3600e3, 'max':3650*24*3600e3 };
  const ivMsMap = {
    '1m':60e3, '2m':2*60e3,'5m':5*60e3,'15m':15*60e3,'30m':30*60e3,
    '1h':3600e3,'4h':4*3600e3,'1d':24*3600e3,'1w':7*24*3600e3
  };
  const span = ranges[range] ?? ranges['1d'];
  const iv = ivMsMap[interval] ?? ivMsMap['5m'];
  const start = now - span;
  const buckets = [];
  for(let t = Math.floor(start/iv)*iv; t<=now; t+=iv){ buckets.push(t); }
  return {buckets, iv};
}

// ---- Krypto-Preise
async function cgMarket(id, vs='usd', range, interval){
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
  const j = await fetchMaybe(url, 'json');
  return (j.prices||[]).map(p=>({ts:p[0], v:p[1]}));
}

// Binance Klines paginiert (tiefe Historie)
async function binanceKlinesPaged(symbol, interval, startMs, endMs){
  const map = { '1m':'1m','2m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d','1w':'1w' };
  const iv = map[interval] ?? '5m';
  const limit = 1000;
  let end = endMs;
  const out = [];
  for(let safety=0; safety<30; safety++){
    const url = `${BN}/api/v3/klines?symbol=${symbol}&interval=${iv}&endTime=${end}&limit=${limit}`;
    const arr = await fetchMaybe(url, 'json'); // [ [openTime, ... , close, ...], ... ] asc
    if(!Array.isArray(arr) || arr.length===0) break;
    out.unshift(...arr); // sammeln
    const firstOpen = arr[0][0];
    if(firstOpen <= startMs) break;
    end = firstOpen - 1;
  }
  return out
    .map(k=>({ts:k[0], v: Number(k[4])}))
    .filter(p=> p.ts>=startMs && p.ts<=endMs)
    .sort((a,b)=>a.ts-b.ts);
}

async function tryBinanceForSymbol(symUpper, range, interval){
  // Heuristik: <SYMBOL>USDT
  const pair = `${symUpper}USDT`;
  // Optionale Verifikation könnte über exchangeInfo laufen; hier direkt klines.
  const now = Date.now();
  const spanMs = { '12h':12*3600e3, '1d':24*3600e3, '7d':7*24*3600e3, '14d':14*24*3600e3, '30d':30*24*3600e3, 'max':90*24*3600e3 }[range] || 24*3600e3;
  const start = now - spanMs;
  try{
    const pts = await binanceKlinesPaged(pair, interval, start, now);
    if(pts.length) return pts;
  }catch(_){}
  return [];
}

export async function fetchCryptoSeries(sel, settings){
  const key = k({t:'crypto', ids: sel.map(s=>s.id), syms: sel.map(s=>s.symbol), settings});
  const cached = await cacheGet(key, 5*60e3); // 5 min
  if(cached) return cached;

  const {range, interval} = settings;
  const series = [];
  for(const c of sel){
    let pts = [];
    // 1) Binance (falls Symbol zuverlässig)
    if(c.symbol){
      pts = await tryBinanceForSymbol((c.symbol||'').toUpperCase(), range, interval);
    }
    // 2) Fallback: CoinGecko
    if(!pts.length){
      try{ pts = await cgMarket(c.id, 'usd', range, interval); } catch(_){ pts = []; }
    }
    series.push({ label: `${(c.symbol||'').toUpperCase()} • ${c.name||c.id}`, points: pts });
  }
  const res = { kind:'crypto', series };
  await cacheSet(key, res);
  return res;
}

// ---- Aktien/ETF-Preise
function mapIntervalToYahoo(iv){
  const map = { '1m':'1m','2m':'2m','5m':'5m','15m':'15m','30m':'30m','1h':'60m','4h':'60m','1d':'1d','1w':'1wk' };
  return map[iv] || '5m';
}
function mapRangeToYahoo(range){
  const map = { '12h':'1d','1d':'1d','7d':'7d','14d':'14d','30d':'30d','max':'max' };
  return map[range] || '7d';
}

async function yfChart(symbol, interval, range){
  const iv = mapIntervalToYahoo(interval);
  const rg = mapRangeToYahoo(range);
  const url = `${YF_CHART}/${encodeURIComponent(symbol)}?interval=${iv}&range=${rg}&includePrePost=true&events=div%2Csplit`;
  const j = await fetchMaybe(url, 'json');
  const r = j?.chart?.result?.[0];
  if(!r) return [];
  const ts = (r.timestamp||[]).map(t=> t*1000);
  const q = r.indicators?.quote?.[0] || {};
  const cl = q.close || [];
  const out = [];
  for(let i=0;i<ts.length;i++){
    const v = cl[i];
    if(v!=null) out.push({ts: ts[i], v:Number(v)});
  }
  return out;
}

async function avTimeSeries(symbol, interval, avKey){
  const intraday = ['1m','2m','5m','15m','30m','1h'].includes(interval);
  if(intraday){
    const map = {'1m':'1min','2m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'60min'};
    const iv = map[interval] || '5min';
    const url = `${AV}?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${iv}&outputsize=full&datatype=json&apikey=${avKey}`;
    const j = await fetchMaybe(url, 'json');
    const key = Object.keys(j).find(k=>k.includes('Time Series')); const obj = j[key]||{};
    return Object.entries(obj).map(([ts,o])=>({ts: Date.parse(ts), v: Number(o['4. close'])})).sort((a,b)=>a.ts-b.ts);
  } else {
    const url = `${AV}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${avKey}`;
    const j = await fetchMaybe(url, 'json');
    const obj = j['Time Series (Daily)']||{};
    return Object.entries(obj).map(([ts,o])=>({ts: Date.parse(ts), v: Number(o['4. close'])})).sort((a,b)=>a.ts-b.ts);
  }
}

async function stooqDaily(symbol){
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}&i=d`;
  const txt = await fetchMaybe(url, 'text');
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

  const {interval, range} = settings;
  const series = [];
  for(const s of sel){
    let pts=[];
    // 1) Yahoo Finance (feine Intervalle) ohne Key
    try{ pts = await yfChart(s.symbol, interval, range); }catch(_){ pts=[]; }
    // 2) Fallback Stooq (daily)
    if(!pts.length){
      try{ pts = await stooqDaily(s.symbol); }catch(_){ pts=[]; }
    }
    // 3) Optional Alpha Vantage, falls Key vorhanden
    if(!pts.length && avKey){
      try{ pts = await avTimeSeries(s.symbol, interval, avKey); }catch(_){ pts=[]; }
    }
    series.push({ label: `${s.symbol} • ${s.name||''}`, points: pts });
  }
  const res = { kind:'equity', series };
  await cacheSet(key, res);
  return res;
}

// ---- Harmonisierung auf Buckets
export function alignToBuckets(buckets, series){
  function nearestVal(points, t){
    if(!points?.length) return null;
    // einfache lineare Suche (Daten überschaubar)
    let best=null, bd=1e18;
    for(const p of points){
      const d = Math.abs(p.ts - t);
      if(d<bd){ bd=d; best=p; }
    }
    return best? best.v : null;
  }
  return series.map(s=>({
    label: s.label,
    values: buckets.map(t=> nearestVal(s.points, t))
  }));
}
