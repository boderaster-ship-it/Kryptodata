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
import { buildCsvWithAnalysis, saveCsv, downloadCsvDirect, buildXlsXml, saveXls } from './export.js';
import { cacheSet } from './storage.js';

const EL = sel => document.querySelector(sel);
const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);

const state = {
  selected: [], // {type:'crypto'|'equity', id/symbol, name, symbol?}
  crypto: { range: '1d', interval: '5m' },
  equity: { enabled: false, range: '1d', interval: '5m' }
};

let LAST_DATASET = null;   // {timestamps, series:[{label,values}] , intervalLabel, count, meta:{type}}
let LAST_ANALYSIS = null;  // [{a,b,probPct,lag,r,n,dir}...]

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
  if(hasOtherType){
    setStatus('Du hast bereits einen anderen Typ gewählt. Bitte zuerst Reset oder die Chips entfernen.');
    return;
  }
  if(item.type==='equity' && !state.equity.enabled){
    setStatus('Aktien/ETF ist deaktiviert. Bitte erst in den Einstellungen aktivieren.');
    return;
  }
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

async function onSearchCrypto(){
  const q = EL('#qCrypto').value;
  const res = await searchCrypto(q);
  renderResults(res, EL('#cryptoResults'));
}
async function onSearchEquity(){
  if(!state.equity.enabled){ setStatus('Aktien/ETF ist deaktiviert.'); return; }
  const q = EL('#qEquity').value;
  const res = await searchEquity(q);
  renderResults(res, EL('#equityResults'));
}
function switchTab(tab){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active', p.id===`pane-${tab}`));
}

// Daten laden
async function loadData(){
  EL('#analysis').innerHTML = ''; LAST_ANALYSIS = null;
  if(state.selected.length===0){ setStatus('Bitte zuerst Werte auswählen.'); return; }
  const typ = state.selected[0].type;
  if(typ==='equity' && !state.equity.enabled){
    setStatus('Aktien/ETF ist deaktiviert. Bitte in den Einstellungen aktivieren oder Aktien entfernen.');
    return;
  }
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

  // Vorschau rendern
  renderPreview(buckets, aligned);

  // Dataset für Export
  LAST_DATASET = {
    timestamps: buckets,
    series: aligned,
    intervalLabel: settings.interval,
    count: state.selected.length,
    meta: { type: typ }
  };
  await cacheSet('last-dataset', LAST_DATASET);
  setStatus('Fertig geladen.');
  setCurrencyNote();
}

// Tabelle Preise
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

// ---------- Lead/Lag (robust, resid.) ----------

// Log-Renditen
function logReturns(arr){
  const out = new Array(arr.length).fill(null);
  for(let i=1;i<arr.length;i++){
    const a = arr[i-1], b = arr[i];
    if(a!=null && b!=null && a>0 && b>0){
      out[i] = Math.log(b/a);
    }else{
      out[i] = null;
    }
  }
  return out;
}

// Hilfe: Median & MAD
function median(vals){
  const a = vals.slice().sort((x,y)=>x-y);
  const n = a.length; if(n===0) return NaN;
  return n%2 ? a[(n-1)/2] : 0.5*(a[n/2-1]+a[n/2]);
}
function mad(vals){
  if(vals.length===0) return NaN;
  const m = median(vals);
  const dev = vals.map(v=> Math.abs(v-m));
  return median(dev);
}

// Normal CDF via erf-Approx
function erf(x){
  // Abramowitz-Stegun 7.1.26
  const sign = x<0 ? -1 : 1;
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  x = Math.abs(x);
  const t = 1/(1+p*x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normalCdf(z){ return 0.5*(1+erf(z/Math.SQRT2)); }

// Fisher-z p-Wert (z ~ N(0,1) für n>25)
function fisherP(r, n){
  if(!Number.isFinite(r) || n<5) return 1.0;
  const z = 0.5*Math.log((1+r)/(1-r)) * Math.sqrt(Math.max(1, n-3));
  const p = 2*(1-normalCdf(Math.abs(z))); // zweiseitig
  return Math.min(1, Math.max(0, p));
}

// Residualisierung gg. Marktfaktor (Cross-Section Median)
function residualize(returnsMatrix){
  // returnsMatrix: Array<N_assets> of arrays length T with nulls
  const N = returnsMatrix.length; if(N===0) return returnsMatrix;
  const T = returnsMatrix[0].length;

  // 1) robuste Normierung pro Asset (MAD über ganze Serie)
  const Rtilde = returnsMatrix.map(r=>{
    const valid = r.filter(v=> v!=null && Number.isFinite(v));
    const s = mad(valid)*1.4826 || 0; // MAD->sigma
    const scale = (s && Number.isFinite(s) && s>1e-12) ? s : ( // fallback: std
      (()=>{
        const m = valid.reduce((a,b)=>a+b,0)/Math.max(1,valid.length);
        const v = valid.reduce((a,b)=>a+(b-m)*(b-m),0)/Math.max(1,valid.length-1);
        return Math.sqrt(Math.max(1e-12, v));
      })()
    );
    return r.map(x=> (x==null? null : x/scale));
  });

  // 2) Marktfaktor f_t = Median_t über Assets (robust)
  const f = new Array(T).fill(null);
  for(let t=0;t<T;t++){
    const vals=[]; for(let i=0;i<N;i++){ const v = Rtilde[i][t]; if(v!=null && Number.isFinite(v)) vals.push(v); }
    f[t] = vals.length ? median(vals) : null;
  }

  // 3) OLS-Beta je Asset gegen f (über alle t mit Daten) und Residuen ε = r~ - β f
  const E = Rtilde.map(r=>{
    let num=0, den=0;
    const fx=[], rx=[];
    for(let t=0;t<T;t++){
      const ft = f[t], rt = r[t];
      if(ft!=null && rt!=null && Number.isFinite(ft) && Number.isFinite(rt)){
        fx.push(ft); rx.push(rt);
      }
    }
    if(fx.length>=5){
      const mx = fx.reduce((a,b)=>a+b,0)/fx.length;
      const my = rx.reduce((a,b)=>a+b,0)/rx.length;
      for(let k=0;k<fx.length;k++){
        const dx = fx[k]-mx; const dy = rx[k]-my;
        num += dx*dy; den += dx*dx;
      }
    }
    const beta = (den>0) ? (num/den) : 0;
    return r.map((rt, t)=> {
      const ft = f[t];
      if(rt==null || ft==null || !Number.isFinite(rt) || !Number.isFinite(ft)) return rt; // wenn f fehlt: keine Korrektur
      return rt - beta*ft;
    });
  });

  return E;
}

// Korrelation bei Lag
function corrAtLag(r1, r2, lag){
  let xs=[], ys=[];
  for(let t=0;t<r1.length;t++){
    const u = r1[t];
    const vIdx = t+lag;
    if(vIdx<0 || vIdx>=r2.length) continue;
    const v = r2[vIdx];
    if(u!=null && v!=null && Number.isFinite(u) && Number.isFinite(v)){ xs.push(u); ys.push(v); }
  }
  const n = xs.length;
  if(n<5) return {n, r: NaN};
  const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
  const mx = mean(xs), my=mean(ys);
  let num=0, dx=0, dy=0;
  for(let i=0;i<n;i++){ const ax=xs[i]-mx, ay=ys[i]-my; num+=ax*ay; dx+=ax*ax; dy+=ay*ay; }
  const r = (dx===0 || dy===0) ? NaN : (num/Math.sqrt(dx*dy));
  return {n, r};
}

// Analyse durchführen + UI-Tabelle + Export-Daten
function analyzeLeadLag(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const { series, intervalLabel } = LAST_DATASET;
  if(series.length<2){ EL('#analysis').innerHTML='<div class="hint">Mindestens 2 Assets nötig.</div>'; return; }

  // 1) Log-Renditen je Serie
  const R = series.map(s=> ({label: s.label, r: logReturns(s.values)}));

  // 2) Residualisierung gg. Marktfaktor (robuste Normierung + OLS-Faktor)
  const returnsMatrix = R.map(x=> x.r);
  const E = residualize(returnsMatrix);

  // 3) Lags scannen
  const T = E[0].length;
  const maxLag = Math.max(1, Math.min(20, Math.floor(T/4)));

  const results = [];
  for(let i=0;i<E.length;i++){
    for(let j=i+1;j<E.length;j++){
      let best = {lag:0, r:NaN, n:0};
      for(let lag=-maxLag; lag<=maxLag; lag++){
        const {n, r} = corrAtLag(E[i], E[j], lag);
        if(!Number.isFinite(r)) continue;
        if(!Number.isFinite(best.r) || Math.abs(r) > Math.abs(best.r)){
          best = {lag, r, n};
        }
      }
      // Richtung & Wahrscheinlichkeit
      const leading = best.lag>0 ? R[i].label : (best.lag<0 ? R[j].label : '—');
      const following= best.lag>0 ? R[j].label : (best.lag<0 ? R[i].label : '—');
      const absLag  = Math.abs(best.lag);
      const p = fisherP(best.r, best.n);
      const probPct = Math.round((1-p)*1000)/10; // eine Nachkommastelle

      results.push({
        a: leading, b: following, lag: absLag, r: best.r, n: best.n,
        probPct, dir: best.lag
      });
    }
  }
  // Sortiere nach Wahrscheinlichkeit, dann |r|
  results.sort((x,y)=> (y.probPct - x.probPct) || (Math.abs(y.r)-Math.abs(x.r)));

  LAST_ANALYSIS = { interval: intervalLabel, rows: results };

  // 4) UI: Tabelle anzeigen (A,B,C,D)
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

  setStatus(`Analyse fertig. 1 Lag = ${intervalLabel}.`);
}

// ---------- Export ----------

async function doExportShare(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  // CSV enthält zuerst Preise, dann Analyse (falls vorhanden)
  const csv = buildCsvWithAnalysis(LAST_DATASET, LAST_ANALYSIS);
  await saveCsv(csv, 'preise_und_leadlag.csv'); // iPhone: Share-Sheet / In Dateien sichern
}
async function doExportXls(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const xml = buildXlsXml(LAST_DATASET, LAST_ANALYSIS); // 2 Worksheets
  await saveXls(xml, 'preise_und_leadlag.xls');
}
function doExportDirect(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const csv = buildCsvWithAnalysis(LAST_DATASET, LAST_ANALYSIS);
  downloadCsvDirect(csv, 'preise_und_leadlag.csv'); // klassischer Download (Laptop/Desktop)
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

  // Direkt-Download nur zeigen, wenn nicht iOS (iOS: Share-Sheet besser)
  if(!isIOS){ EL('#directDownloadBtn').hidden = false; EL('#directDownloadBtn').onclick = doExportDirect; }

  EL('#resetBtn').onclick = ()=>{
    state.selected = []; renderChips(); enforceTypeConstraints();
    EL('#cryptoResults').innerHTML=''; EL('#equityResults').innerHTML='';
    EL('#qCrypto').value=''; EL('#qEquity').value='';
    EL('#preview').innerHTML=''; EL('#analysis').innerHTML=''; LAST_DATASET=null; LAST_ANALYSIS=null; setCurrencyNote(); setStatus('Zurückgesetzt.');
  };

  // PWA Install (iOS: Add-to-Home im Share-Sheet)
  let deferredPrompt; window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt=e; const btn=EL('#installBtn'); if(btn) btn.hidden=false; });
  EL('#installBtn')?.addEventListener('click', async ()=>{ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; EL('#installBtn').hidden=true; } });

  enforceTypeConstraints();
}
document.addEventListener('DOMContentLoaded', init);
