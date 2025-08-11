import {searchCrypto, searchEquity, buildBuckets, fetchCryptoSeries, fetchEquitySeries, alignToBuckets} from './providers.js';
import {buildCsv, downloadCsv} from './export.js';
import {cacheSet} from './storage.js';

const EL = sel => document.querySelector(sel);
const state = {
  range: '1d',
  interval: '5m',
  avKey: '',
  selected: [] // {type:'crypto'|'equity', id/symbol, name, symbol?}
};

function setStatus(msg){ EL('#status').textContent = msg || ''; }
function renderChips(){
  const box = EL('#selectedChips'); box.innerHTML='';
  for(const it of state.selected){
    const chip = document.createElement('div'); chip.className='chip';
    chip.innerHTML = `<span>${it.type==='crypto' ? '🪙' : '📊'} ${it.symbol||it.id} • ${it.name||''}</span><span class="x" title="entfernen">×</span>`;
    chip.querySelector('.x').onclick = ()=>{
      state.selected = state.selected.filter(s=> (s.id||s.symbol)!==(it.id||it.symbol));
      renderChips();
    };
    box.appendChild(chip);
  }
}

function addSelection(item){
  const key = item.id || item.symbol;
  if(state.selected.some(s=> (s.id||s.symbol)===key)) return;
  state.selected.push(item); renderChips();
}

function renderResults(list, ul){
  ul.innerHTML='';
  for(const it of list.slice(0,50)){
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div><strong>${it.symbol||it.id}</strong> – ${it.name||''}</div>
        <div class="badge">${it.type}</div>
      </div>
      <button class="add">Hinzufügen</button>`;
    li.querySelector('.add').onclick=()=>addSelection(it);
    ul.appendChild(li);
  }
}

// Debounce
function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

async function onSearchCrypto(){
  const q = EL('#qCrypto').value;
  const res = await searchCrypto(q);
  renderResults(res, EL('#cryptoResults'));
}
async function onSearchEquity(){
  const q = EL('#qEquity').value;
  const res = await searchEquity(q, state.avKey);
  renderResults(res, EL('#equityResults'));
}

function switchTab(tab){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active', p.id===`pane-${tab}`));
}

async function loadData(){
  if(state.selected.length===0){ setStatus('Bitte zuerst Werte auswählen.'); return; }
  setStatus('Lade Daten …');

  const settings = {range: state.range, interval: state.interval};
  const cryptoSel = state.selected.filter(s=>s.type==='crypto');
  const eqSel     = state.selected.filter(s=>s.type==='equity');

  const buckets = buildBuckets(state.range, state.interval);
  const seriesAll = [];

  if(cryptoSel.length){
    const cs = await fetchCryptoSeries(cryptoSel, settings);
    seriesAll.push(...cs.series);
  }
  if(eqSel.length){
    const es = await fetchEquitySeries(eqSel, settings, state.avKey);
    seriesAll.push(...es.series);
  }

  const aligned = alignToBuckets(buckets.buckets, seriesAll);
  // Vorschau rendern
  renderPreview(buckets.buckets, aligned);
  // Cache für Export
  await cacheSet('last-dataset', {timestamps: buckets.buckets, series: aligned, intervalLabel: state.interval, count: state.selected.length});
  setStatus('Fertig geladen.');
}

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

async function doExport(){
  const ds = await (await caches.open('static')).match('last-dataset'); // nicht geeignet -> wir haben in IndexedDB gespeichert
  // Stattdessen holen aus cache via storage.js war einfacher, aber wir haben nur cacheSet dort.
  // Pragmatik: Wir speichern zuletzt direkt an window:
}

window._lastDataset = null; // fallback
async function exportNow(){
  if(!window._lastDataset){
    setStatus('Bitte zuerst „Preisdaten laden“.'); return;
  }
  const csv = buildCsv(window._lastDataset);
  downloadCsv(csv, 'preise_export.csv');
}

// Init
function init(){
  // Events
  EL('#rangeSel').onchange = e => state.range = e.target.value;
  EL('#intervalSel').onchange = e => state.interval = e.target.value;
  EL('#saveKeyBtn').onclick = ()=>{
    state.avKey = EL('#avKey').value.trim();
    localStorage.setItem('avKey', state.avKey||'');
    setStatus(state.avKey ? 'AlphaVantage Key gespeichert.' : 'Key entfernt.');
  };
  state.avKey = localStorage.getItem('avKey')||'';
  if(state.avKey) EL('#avKey').value = state.avKey;

  EL('#qCrypto').oninput = debounce(onSearchCrypto, 250);
  EL('#qEquity').oninput = debounce(onSearchEquity, 300);

  document.querySelectorAll('.tab').forEach(b=> b.onclick = ()=>switchTab(b.dataset.tab));
  EL('#loadBtn').onclick = async ()=>{
    await loadData();
    // baue LastDataset fürs Export
    const {buckets} = buildBuckets(state.range, state.interval);
    const previewTable = EL('#preview table');
    // Wir haben aligned schon beim Render; bauen Dataset aus DOM zurück:
    const timestamps = buckets;
    const rows = Array.from(previewTable?.querySelectorAll('tbody tr')||[]);
    const series = rows.map(r=>{
      const tds = r.querySelectorAll('td');
      return {label: tds[0].textContent, values: Array.from(tds).slice(1).map(td=> td.textContent ? Number(td.textContent.replace(',','.')) : null)};
    });
    window._lastDataset = {timestamps, series, intervalLabel: state.interval, count: state.selected.length};
  };
  EL('#exportBtn').onclick = exportNow;
  EL('#resetBtn').onclick = ()=>{
    state.selected = []; renderChips();
    EL('#cryptoResults').innerHTML=''; EL('#equityResults').innerHTML='';
    EL('#qCrypto').value=''; EL('#qEquity').value='';
    EL('#preview').innerHTML=''; setStatus('Zurückgesetzt.');
  };

  // PWA Install (iOS zeigt Add-to-Home im Share-Sheet)
  let deferredPrompt; window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt=e; EL('#installBtn').hidden=false; });
  EL('#installBtn').onclick = async ()=>{ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; EL('#installBtn').hidden=true; } };
}
document.addEventListener('DOMContentLoaded', init);
