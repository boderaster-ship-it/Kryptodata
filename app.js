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
import { buildCsv, saveCsv, downloadCsvDirect } from './export.js';
import { cacheSet } from './storage.js';

const EL = sel => document.querySelector(sel);
const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);

const state = {
  selected: [], // {type:'crypto'|'equity', id/symbol, name, symbol?}
  crypto: { range: '1d', interval: '5m' },
  equity: { enabled: false, range: '1d', interval: '5m' }
};

let LAST_DATASET = null; // {timestamps, series, intervalLabel, count, meta:{type}}
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

// Ergebnisse/Chips
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

  // Mischen verhindern: nicht gleichzeitig Krypto & Aktien
  if(hasCrypto && hasEquity){
    setStatus('Bitte nicht mischen: Entferne erst die vorhandene Auswahl, bevor du den anderen Typ auswählst.');
  }
  // Equity-UI je nach Toggle
  const equityEnabled = state.equity.enabled;
  EL('#qEquity').disabled = !equityEnabled;
  EL('#rangeEquitySel').disabled = !equityEnabled;
  EL('#intervalEquitySel').disabled = !equityEnabled;

  // Tab „Aktien“ visuell sperren, wenn deaktiviert
  const equityTabBtn = document.querySelector('.tab[data-tab="equity"]');
  if(equityTabBtn) equityTabBtn.style.opacity = equityEnabled ? '1' : '0.5';
}

// Auswahl & Suche
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
  EL('#analysis').textContent = ''; // Analyse leeren
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

// Tabelle
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

// Lead/Lag Analyse (diskrete Kreuz-Korrelation der Log-Renditen)
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
function corrAtLag(r1, r2, lag){
  // vergleiche r1[t] mit r2[t+lag]
  let xs=[], ys=[];
  for(let t=0;t<r1.length;t++){
    const u = r1[t];
    const vIdx = t+lag;
    if(vIdx<0 || vIdx>=r2.length) continue;
    const v = r2[vIdx];
    if(u!=null && v!=null){ xs.push(u); ys.push(v); }
  }
  const n = xs.length;
  if(n<5) return {n, r: NaN};
  const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
  const mx = mean(xs), my=mean(ys);
  let num=0, dx=0, dy=0;
  for(let i=0;i<n;i++){
    const ax = xs[i]-mx, ay=ys[i]-my;
    num += ax*ay; dx += ax*ax; dy += ay*ay;
  }
  const r = (dx===0 || dy===0) ? NaN : (num/Math.sqrt(dx*dy));
  return {n, r};
}
function analyzeLeadLag(){
  EL('#analysis').textContent='';
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const { series, intervalLabel } = LAST_DATASET;
  if(series.length<2){ EL('#analysis').textContent='Mindestens 2 Assets nötig für Lead/Lag.'; return; }

  // Log-Renditen je Serie
  const R = series.map(s=> ({label: s.label, r: logReturns(s.values)}));
  // Lag-Bereich (±maxLag)
  const N = series[0].values.length;
  const maxLag = Math.max(1, Math.min(20, Math.floor(N/4)));

  const results = [];
  for(let i=0;i<R.length;i++){
    for(let j=i+1;j<R.length;j++){
      let best = {lag:0, r:NaN, n:0};
      for(let lag=-maxLag; lag<=maxLag; lag++){
        const {n, r} = corrAtLag(R[i].r, R[j].r, lag);
        if(!Number.isFinite(r)) continue;
        if(!Number.isFinite(best.r) || Math.abs(r) > Math.abs(best.r)){
          best = {lag, r, n};
        }
      }
      // Interpretation: corr(r_i[t], r_j[t+lag]). lag>0 => i führt j um lag Intervalle
      const direction = best.lag>0 ? `${R[i].label} führt ${R[j].label}` :
                         best.lag<0 ? `${R[j].label} führt ${R[i].label}` :
                         'Kein Vorlauf (lag=0)';
      const absLag = Math.abs(best.lag);
      results.push({
        pair: `${R[i].label} ↔ ${R[j].label}`,
        direction,
        lag: absLag,
        r: best.r,
        n: best.n
      });
    }
  }
  // sortiere nach |r| absteigend
  results.sort((a,b)=> Math.abs(b.r) - Math.abs(a.r));

  // Ausgabe (Text)
  const ivTextMap = {'1m':'1 Minute','2m':'2 Minuten','5m':'5 Minuten','15m':'15 Minuten','30m':'30 Minuten','1h':'1 Stunde','4h':'4 Stunden','1d':'1 Tag','1w':'1 Woche'};
  const ivText = ivTextMap[intervalLabel] || intervalLabel;
  const lines = [];
  lines.push(`Lead/Lag-Analyse (diskrete Kreuz-Korrelation der Log-Renditen; 1 Lag = ${ivText}).`);
  for(const r of results){
    const pct = (r.r*100).toFixed(1).replace('.',',') + '%';
    const lagTxt = r.lag===0 ? '0' : String(r.lag);
    lines.push(`• ${r.direction} um ${lagTxt} Lag(s) – ρ = ${pct} (N=${r.n})`);
  }
  lines.push('Hinweis: Methode angelehnt an High-Frequency-Lead/Lag-Analysen (z. B. Hayashi-Yoshida/Cross-Correlation); hier diskret auf gebucketeten Daten umgesetzt.');
  EL('#analysis').textContent = lines.join('\n');
}

// Export
async function doExportShare(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const csv = buildCsv(LAST_DATASET);
  await saveCsv(csv, 'preise_export.csv'); // iPhone: Share-Sheet / In Dateien sichern
}
function doExportDirect(){
  if(!LAST_DATASET){ setStatus('Bitte zuerst „Preisdaten laden“.'); return; }
  const csv = buildCsv(LAST_DATASET);
  downloadCsvDirect(csv, 'preise_export.csv'); // klassischer Download (Laptop/Desktop)
}

// Init UI
function init(){
  // Settings Events
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
  // Direkt-Download nur zeigen, wenn nicht iOS
  if(!isIOS){ EL('#directDownloadBtn').hidden = false; EL('#directDownloadBtn').onclick = doExportDirect; }

  EL('#resetBtn').onclick = ()=>{
    state.selected = []; renderChips(); enforceTypeConstraints();
    EL('#cryptoResults').innerHTML=''; EL('#equityResults').innerHTML='';
    EL('#qCrypto').value=''; EL('#qEquity').value='';
    EL('#preview').innerHTML=''; EL('#analysis').textContent=''; LAST_DATASET=null; setCurrencyNote(); setStatus('Zurückgesetzt.');
  };

  // PWA Install (iOS: Add-to-Home im Share-Sheet)
  let deferredPrompt; window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt=e; const btn=EL('#installBtn'); if(btn) btn.hidden=false; });
  EL('#installBtn')?.addEventListener('click', async ()=>{ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; EL('#installBtn').hidden=true; } });

  enforceTypeConstraints();
}
document.addEventListener('DOMContentLoaded', init);
