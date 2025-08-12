// Globale Fehler sichtbar machen
window.addEventListener('error', (e)=>{
  const box = document.querySelector('#status');
  if(box) box.textContent = 'Fehler: ' + (e?.error?.message || e.message || 'Unbekannt');
});
window.addEventListener('unhandledrejection', (e)=>{
  const box = document.querySelector('#status');
  if(box) box.textContent = 'Async-Fehler: ' + (e?.reason?.message || String(e.reason));
});

// Module importieren
import {
  searchCrypto, searchEquity, buildBuckets,
  fetchCryptoSeries, fetchEquitySeries, alignToBuckets
} from './providers.js';
import { buildCsvWithProcessedAndAnalysis, saveCsv, downloadCsvDirect, buildXlsXml, saveXls } from './export.js';
import { cacheSet } from './storage.js';

const EL = sel => document.querySelector(sel);
const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);

const state = {
  selected: [], // {type:'crypto'|'equity', id/symbol, name, symbol?}
  crypto: { range: '1d', interval: '5m' },
  equity: { enabled: false, range: '1d', interval: '5m' }
};

let LAST_DATASET = null;   // {timestamps, series:[{label,values}], seriesProcessed:[{label,values}], intervalLabel, count, meta:{type}}
let LAST_ANALYSIS = null;  // {interval, rows:[{a,b,probPct,lag}]}

function setStatus(msg){ EL('#status').textContent = msg || ''; }
function setCurrencyNote(){
  const note = EL('#currencyNote');
  if(!LAST_DATASET){ note.textContent=''; return; }
  if(LAST_DATASET.meta?.type==='crypto'){
    note.textContent = 'Hinweis: Krypto-Preise in USD (CoinGecko) bzw. USDT≈USD (Binance). 1 Lag = ausgewählter Krypto-Datenabstand.';
  }else if(LAST_DATASET.meta?.type==='equity'){
    note.textContent = 'Hinweis: Aktien/ETF-Währung je nach Symbol/Quelle (Yahoo Finance, Stooq). 1 Lag = ausgewählter Aktien-Datenabstand.';
  }else{
    note.textContent = '';
  }
}

// Chips / Auswahl
function renderChips(){
  const box = EL('#selectedChips'); box.innerHTML='';
  for(const it of state.selected){
    const chip = document.createElement('div'); chip.className='chip';
    chip.innerHTML = `<span>${it.type==='crypto' ? '🪙' : '📊'} ${it.symbol||it.id} • ${it.name||''}</span><span class="x" title="entfernen">×</span>`;
    chip.querySelector('.x').onclick = ()=>{
      state.selected = state.selected.filter(s=> (s.id||s.symbol)!==(it.id||it.symbol));
      renderChips();
      enforceTypeConstraints();
    };
    box.appendChild(chip);
  }
}
function enforceTypeConstraints(){
  const hasCrypto = state.selected.some(s=>s.type==='crypto');
  const hasEquity = state.selected.some(s=>s.type==='equity');
  if(hasCrypto && hasEquity){
    setStatus('Bitte nicht mischen: Entferne erst die vorhandene Auswahl, bevor du den anderen Typ auswählst.');
  }
  const equityEnabled = state.equity.enabled;
  EL('#qEquity').disabled = !equityEnabled;
  EL('#rangeEquitySel').disabled = !equityEnabled;
  EL('#intervalEquitySel').disabled = !equityEnabled;
  const equityTabBtn = document.querySelector('.tab[data-tab="equity"]');
  if(equityTabBtn) equityTabBtn.style.opacity = equityEnabled ? '1' : '0.5';
}
function addSelection(item){
  const key = item.id || item.symbol;
  if(state.selected.some(s=> (s.id||s.symbol)===key)) return;
  const hasOtherType = state.selected.length>0 && state.selected[0].type !== item.type;
  if(hasOtherType){ setStatus('Du hast bereits einen anderen Typ gewählt. Bitte zuerst Reset oder die Chips entfernen.'); return; }
  if(item.type==='equity' && !state.equity.enabled){ setStatus('Aktien/ETF ist deaktiviert. Bitte erst in den Einstellungen aktivieren.'); return; }
  state.selected.push(item); renderChips();
}
function renderResults(list, ul){
  ul.innerHTML='';
  for(const it of list.slice(0,100)){
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div><strong>${it.symbol||it.id}</strong> – ${it.name||''}</div>
        <div class="badge">${it.type}${it.region ? ' • '+it.region : ''}${it.currency ? ' • '+it.currency : ''}</div>
      </div>
      <button class="add">Hinzufügen</button>`;
    li.querySelector('.add').onclick=()=>addSelection(it);
    ul.appendChild(li);
  }
}
function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
async function onSearchCrypto(){ const q = EL('#qCrypto').value; const res = await searchCrypto(q); renderResults(res, EL('#cryptoResults')); }
async function onSearchEquity(){ if(!state.equity.enabled){ setStatus('Aktien/ETF ist deaktiviert.'); return; } const q = EL('#qEquity').value; const res = await searchEquity(q); renderResults(res, EL('#equityResults')); }
function switchTab(tab){ document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab)); document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active', p.id===`pane-${tab}`)); }

// ---------- Laden & Rendern ----------
async function loadData(){
  EL('#analysis').innerHTML = ''; LAST_ANALYSIS = null;
  EL('#processed').innerHTML = '';
  if(state.selected.length===0){ setStatus('Bitte zuerst Werte auswählen.'); return; }
  const typ = state.selected[0].type;
  if(typ==='equity' && !state.equity.enabled){ setStatus('Aktien/ETF ist deaktiviert. Bitte in den Einstellungen aktivieren oder Aktien entfernen.'); return; }
  setStatus('Lade Daten …');

  const settings = (typ==='crypto')
    ? {range: state.crypto.range, interval: state.crypto.interval}
    : {range: state.equity.range, interval: state.equity.interval};

  const { buckets } = buildBuckets(settings.range, settings.interval);
  const seriesAll = [];

  if(typ==='crypto'){
    const cs = await fetchCryptoSeries(state.selected, settings);
    seriesAll.push(...cs.series);
  } else {
    const es = await fetchEquitySeries(state.selected, settings, null); // kein AV-Key
    seriesAll.push(...es.series);
  }

  const aligned = alignToBuckets(buckets, seriesAll);

  // Tabelle 1: Preise
  renderPreview(buckets, aligned);

  // Tabelle 2: Prozent-Veränderung (zum Vorwert, Basis = VORWERT selbst!)
  const processed = buildPercentChangePrev(aligned);
  renderProcessed(buckets, processed);

  // Dataset für Export & Analyse
  LAST_DATASET = {
    timestamps: buckets,
    series: aligned,
    seriesProcessed: processed,
    intervalLabel: settings.interval,
    count: state.selected.length,
    meta: { type: typ }
  };
  await cacheSet('last-dataset', LAST_DATASET);
  setStatus('Fertig geladen.');
  setCurrencyNote();
}

// Tabelle 1: Preise
function renderPreview(ts, aligned){
  const wrap = EL('#preview'); wrap.innerHTML='';
  const tbl = document.createElement('table');
  const thead = document.createElement('thead'); const trh=document.createElement('tr');
  trh.innerHTML = ['Asset', ...ts.map(t=> new Date(t).toLocaleString())].map(h=>`<th>${h}</th>`).join('');
  thead.appendChild(trh);
  const tb = document.createElement('tbody');
  for(const s of aligned){
    const tr=document.createElement('tr');
    tr.innerHTML = [`<td>${s.label}</td>`, ...s.values.map(v=> `<td>${v==null?'':Number(v).toFixed(6)}</td>`)].join('');
    tb.appendChild(tr);
  }
  tbl.appendChild(thead); tbl.appendChild(tb); wrap.appendChild(tbl);
}

// Tabelle 2: Prozent-Veränderung zum VORWERT (klassisch), erste gültige = 0
function buildPercentChangePrev(aligned){
  return aligned.map(s=>{
    const vals = s.values;
    const out = vals.map(()=> null);

    // ersten gültigen Index finden
    let i0 = -1;
    for(let i=0;i<vals.length;i++){ if(vals[i]!=null && Number.isFinite(vals[i])){ i0=i; break; } }
    if(i0===-1) return {label:s.label, values: out};

    out[i0] = 0;
    for(let i=i0+1;i<vals.length;i++){
      const prev = vals[i-1], cur = vals[i];
      if(prev!=null && cur!=null && Number.isFinite(prev) && Number.isFinite(cur) && prev!==0){
        out[i] = ((cur - prev)/prev)*100;
      }else{
        out[i] = null;
      }
    }
    return {label:s.label, values: out};
  });
}
function renderProcessed(ts, processed){
  const wrap = EL('#processed'); wrap.innerHTML='';
  const tbl = document.createElement('table');
  const thead = document.createElement('thead'); const trh=document.createElement('tr');
  trh.innerHTML = ['Asset', ...ts.map(t=> new Date(t).toLocaleString())].map(h=>`<th>${h}</th>`).join('');
  thead.appendChild(trh);
  const tb = document.createElement('tbody');
  for(const s of processed){
    const tr=document.createElement('tr');
    tr.innerHTML = [`<td>${s.label}</td>`, ...s.values.map(v=> `<td>${v==null?'':Number(v).toFixed(6)}</td>`)].join('');
    tb.appendChild(tr);
  }
  tbl.appendChild(thead); tbl.appendChild(tb); wrap.appendChild(tbl);
}

// ---------- Analyse: Häufigkeits-basierter Lead/Lag ----------

// Korrelation im Fenster bei fixem Lag
function corrWindowAtLag(a, b, lag, start, end){
  let xs=[], ys=[];
  for(let t=start; t<=end; t++){
    const u = a[t];
    const vIdx = t + lag;
    if(vIdx<0 || vIdx>=b.length) continue;
    const v = b[vIdx];
    if(u!=null && v!=null && Number.isFinite(u) && Number.isFinite(v)){
      xs.push(u); ys.push(v);
    }
  }
  const n = xs.length;
  if(n<5) return {n, r: NaN};
  const mean = arr => arr.reduce((s,x)=>s+x,0)/arr.length;
  const mx = mean(xs), my = mean(ys);
  let num=0, dx=0, dy=0;
  for(let i=0;i<n;i++){ const ax=xs[i]-mx, ay=ys[i]-my; num+=ax*ay; dx+=ax*ax; dy+=ay*ay; }
  const r = (dx===0 || dy===0) ? NaN : num/Math.sqrt(dx*dy);
  return {n, r};
}

function analyzeLeadLag(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const { seriesProcessed, intervalLabel } = LAST_DATASET;
  if(!seriesProcessed || seriesProcessed.length<2){ EL('#analysis').innerHTML='<div class="hint">Mindestens 2 Assets nötig.</div>'; return; }

  const N = seriesProcessed[0].values.length;
  const MAX_LAG = 10;                // (fix laut Spezifikation)
  let   WIN = Math.max(20, 3*MAX_LAG);
  WIN = Math.min(WIN, Math.max(10, N - MAX_LAG)); // bei kurzen Reihen schrumpfen
  const MIN_N = 10; // minimale Effektiv-Stichprobe je Fenster/Lag

  const tStart = Math.max(WIN-1 + MAX_LAG, 0);
  const tEnd   = Math.min(N-1 - MAX_LAG, N-1);
  const totalWindowsNominal = Math.max(0, tEnd - tStart + 1);

  const results = [];

  for(let i=0;i<seriesProcessed.length;i++){
    for(let j=i+1;j<seriesProcessed.length;j++){
      // Zähler für alle Lags
      const counts = new Map();
      for(let l=-MAX_LAG; l<=MAX_LAG; l++){ if(l!==0) counts.set(l,0); }
      let totalWins = 0;

      if(totalWindowsNominal>0){
        for(let t=tStart; t<=tEnd; t++){
          const start = t - WIN + 1, end = t;
          let bestLag = null, bestAbs = -1;

          for(let l=-MAX_LAG; l<=MAX_LAG; l++){
            if(l===0) continue;
            const {n, r} = corrWindowAtLag(seriesProcessed[i].values, seriesProcessed[j].values, l, start, end);
            if(n < MIN_N || !Number.isFinite(r)) continue;
            const ar = Math.abs(r);
            if(ar > bestAbs){ bestAbs = ar; bestLag = l; }
          }
          if(bestLag!==null){
            counts.set(bestLag, counts.get(bestLag)+1);
            totalWins++;
          }
        }
      }

      // Bestimmen des häufigsten Lags
      let lagBest = 0, cntBest = 0;
      for(const [l,c] of counts.entries()){
        if(c > cntBest || (c===cntBest && Math.abs(l) < Math.abs(lagBest))){ lagBest = l; cntBest = c; }
      }
      const probPct = totalWins>0 ? (cntBest/totalWins)*100 : 0;

      // Richtung ableiten
      const leading = lagBest>0 ? seriesProcessed[i].label : (lagBest<0 ? seriesProcessed[j].label : seriesProcessed[i].label);
      const following= lagBest>0 ? seriesProcessed[j].label : (lagBest<0 ? seriesProcessed[i].label : seriesProcessed[j].label);
      const absLag  = Math.abs(lagBest);

      results.push({ a: leading, b: following, probPct: Math.round(probPct*10)/10, lag: absLag, totalWins });
    }
  }

  // Sortierung: erst Wahrscheinlichkeit, dann Lag (kleiner ist praxisnäher)
  results.sort((x,y)=> (y.probPct - x.probPct) || (x.lag - y.lag));

  LAST_ANALYSIS = { interval: intervalLabel, rows: results };

  // UI-Tabelle
  const box = EL('#analysis'); box.innerHTML='';
  const tbl = document.createElement('table');
  const thead = document.createElement('thead'); const trh = document.createElement('tr');
  trh.innerHTML = ['Währung A (führt)', 'Währung B', 'Wahrscheinlichkeit (%)', 'Vorlauf (Lags)'].map(h=>`<th>${h}</th>`).join('');
  thead.appendChild(trh);
  const tb = document.createElement('tbody');
  for(const r of results){
    const tr = document.createElement('tr');
    tr.innerHTML = [
      `<td>${r.a}</td>`,
      `<td>${r.b}</td>`,
      `<td>${r.probPct.toFixed(1).replace('.',',')}</td>`,
      `<td>${r.lag}</td>`
    ].join('');
    tb.appendChild(tr);
  }
  tbl.appendChild(thead); tbl.appendChild(tb); box.appendChild(tbl);

  setStatus(`Analyse fertig. Grundlage: Prozent-Veränderung zum VORWERT. 1 Lag = ${intervalLabel}. Fenstergröße ~ ${WIN}, Fenster gesamt: ${results.length ? (results[0].totalWins||0) : 0}.`);
}

// ---------- Export ----------
async function doExportShare(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const csv = buildCsvWithProcessedAndAnalysis(LAST_DATASET, LAST_ANALYSIS);
  await saveCsv(csv, 'preise_prozent_leadlag.csv');
}
async function doExportXls(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const xml = buildXlsXml(LAST_DATASET, LAST_ANALYSIS); // 3 Worksheets
  await saveXls(xml, 'preise_prozent_leadlag.xls');
}
function doExportDirect(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const csv = buildCsvWithProcessedAndAnalysis(LAST_DATASET, LAST_ANALYSIS);
  downloadCsvDirect(csv, 'preise_prozent_leadlag.csv');
}

// ---------- Init ----------
function init(){
  // Settings
  EL('#rangeCryptoSel').onchange = e => state.crypto.range = e.target.value;
  EL('#intervalCryptoSel').onchange = e => state.crypto.interval = e.target.value;

  EL('#equityEnable').onchange = e => {
    state.equity.enabled = !!e.target.checked;
    enforceTypeConstraints();
    setStatus(state.equity.enabled ? 'Aktien/ETF aktiviert.' : 'Aktien/ETF deaktiviert.');
  };
  EL('#rangeEquitySel').onchange = e => state.equity.range = e.target.value;
  EL('#intervalEquitySel').onchange = e => state.equity.interval = e.target.value;

  // Suche
  EL('#qCrypto').oninput = debounce(onSearchCrypto, 250);
  EL('#qEquity').oninput = debounce(onSearchEquity, 300);

  // Tabs
  document.querySelectorAll('.tab').forEach(b=> b.onclick = ()=>switchTab(b.dataset.tab));

  // Aktionen
  EL('#loadBtn').onclick = loadData;
  EL('#analyzeBtn').onclick = analyzeLeadLag;
  EL('#exportBtn').onclick = doExportShare;
  EL('#exportXlsBtn').onclick = doExportXls;

  if(!isIOS){ EL('#directDownloadBtn').hidden = false; EL('#directDownloadBtn').onclick = doExportDirect; }

  EL('#resetBtn').onclick = ()=>{
    state.selected = []; renderChips(); enforceTypeConstraints();
    EL('#cryptoResults').innerHTML=''; EL('#equityResults').innerHTML='';
    EL('#qCrypto').value=''; EL('#qEquity').value='';
    EL('#preview').innerHTML=''; EL('#processed').innerHTML=''; EL('#analysis').innerHTML='';
    LAST_DATASET=null; LAST_ANALYSIS=null; setCurrencyNote(); setStatus('Zurückgesetzt.');
  };

  // PWA Install (iOS: Add-to-Home im Share-Sheet)
  let deferredPrompt; window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt=e; const btn=EL('#installBtn'); if(btn) btn.hidden=false; });
  EL('#installBtn')?.addEventListener('click', async ()=>{ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; EL('#installBtn').hidden=true; } });

  enforceTypeConstraints();
}
document.addEventListener('DOMContentLoaded', init);
