// ---------- CSV ----------

function toCsvRow(arr){
  return arr.map(v=>{
    if (v===null||v===undefined) return '';
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(';'); // DE Excel: Semikolon
}

function buildPricesCsvBlock(dataset){
  const lines = [];
  // Kopf
  lines.push(toCsvRow(['', ...dataset.timestamps.map(()=> 'Zeit')]));
  // A2 = Anzahl; ab B2 ISO-TS
  lines.push(toCsvRow([dataset.count, ...dataset.timestamps.map(ts=> new Date(ts).toISOString())]));
  // Assets
  for (const s of dataset.series){
    lines.push(toCsvRow([s.label, ...s.values]));
  }
  return lines;
}

function buildProcessedCsvBlock(dataset){
  const lines = [];
  lines.push(toCsvRow(['', ...dataset.timestamps.map(()=> 'Zeit')]));
  lines.push(toCsvRow([dataset.count, ...dataset.timestamps.map(ts=> new Date(ts).toISOString())]));
  for (const s of dataset.seriesProcessed){
    lines.push(toCsvRow([s.label, ...s.values]));
  }
  return lines;
}

function buildAnalysisCsvBlock(analysis){
  const lines = [];
  lines.push(toCsvRow(['Währung A (führt)','Währung B','Wahrscheinlichkeit (%)','Vorlauf (Lags)']));
  if(analysis && analysis.rows){
    for(const r of analysis.rows){
      lines.push(toCsvRow([
        r.a, r.b,
        (r.probPct!=null ? r.probPct.toFixed(1).replace('.',',') : ''),
        r.lag
      ]));
    }
  }
  return lines;
}

export function buildCsvWithProcessedAndAnalysis(dataset, analysis){
  const out = [];
  // Preise
  out.push(...buildPricesCsvBlock(dataset));
  out.push(''); // Leerzeile
  // Prozent-Veränderung
  out.push(...buildProcessedCsvBlock(dataset));
  out.push('');
  // Analyse (falls vorhanden)
  out.push(...buildAnalysisCsvBlock(analysis || {rows:[]}));
  return out.join('\n');
}

// iPhone/Tablet/Browser: primär Share-Sheet („In Dateien sichern“), sonst Tab öffnen, sonst Download
export async function saveCsv(csv, filename='preise_prozent_leadlag.csv'){
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const file = new File([blob], filename, {type: 'text/csv'});

  try{
    if (navigator.canShare && navigator.canShare({ files:[file] })) {
      await navigator.share({
        files: [file],
        title: 'Preisdaten Export',
        text: 'Export aus Data Capture Pro'
      });
      return;
    }
  }catch(_){ /* fallback */ }

  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank'); // iOS → „Teilen/Dateien“
  if(!w){
    const a = Object.assign(document.createElement('a'), {href:url, download:filename});
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}

export function downloadCsvDirect(csv, filename='preise_prozent_leadlag.csv'){
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {href:url, download:filename});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}

// ---------- Excel-XML (.xls) mit 3 Worksheets ----------

function xmlEscape(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildPricesWorksheetXml(dataset){
  const rows = [];
  rows.push(`<Row>${[''].concat(dataset.timestamps.map(()=> 'Zeit')).map(v=>`<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('')}</Row>`);
  rows.push(`<Row>${[dataset.count].concat(dataset.timestamps.map(ts=> new Date(ts).toISOString()))
    .map((v,i)=> i===0? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('')}</Row>`);
  for(const s of dataset.series){
    const cells = [`<Cell><Data ss:Type="String">${xmlEscape(s.label)}</Data></Cell>`]
      .concat(s.values.map(v=> v==null ? `<Cell><Data ss:Type="String"></Data></Cell>` : `<Cell><Data ss:Type="Number">${v}</Data></Cell>`));
    rows.push(`<Row>${cells.join('')}</Row>`);
  }
  return `<Worksheet ss:Name="Preise"><Table>${rows.join('')}</Table></Worksheet>`;
}

function buildProcessedWorksheetXml(dataset){
  const rows = [];
  rows.push(`<Row>${[''].concat(dataset.timestamps.map(()=> 'Zeit')).map(v=>`<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('')}</Row>`);
  rows.push(`<Row>${[dataset.count].concat(dataset.timestamps.map(ts=> new Date(ts).toISOString()))
    .map((v,i)=> i===0? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`).join('')}</Row>`);
  for(const s of dataset.seriesProcessed){
    const cells = [`<Cell><Data ss:Type="String">${xmlEscape(s.label)}</Data></Cell>`]
      .concat(s.values.map(v=> v==null ? `<Cell><Data ss:Type="String"></Data></Cell>` : `<Cell><Data ss:Type="Number">${v}</Data></Cell>`));
    rows.push(`<Row>${cells.join('')}</Row>`);
  }
  return `<Worksheet ss:Name="Prozent"><Table>${rows.join('')}</Table></Worksheet>`;
}

function buildLeadLagWorksheetXml(analysis){
  const header = ['Währung A (führt)','Währung B','Wahrscheinlichkeit (%)','Vorlauf (Lags)'];
  const rows = [];
  rows.push(`<Row>${header.map(h=>`<Cell><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`).join('')}</Row>`);
  if(analysis && analysis.rows){
    for(const r of analysis.rows){
      const cells = [
        `<Cell><Data ss:Type="String">${xmlEscape(r.a||'')}</Data></Cell>`,
        `<Cell><Data ss:Type="String">${xmlEscape(r.b||'')}</Data></Cell>`,
        `<Cell><Data ss:Type="Number">${(r.probPct!=null? r.probPct.toFixed(1) : '')}</Data></Cell>`,
        `<Cell><Data ss:Type="Number">${r.lag!=null? r.lag : ''}</Data></Cell>`
      ];
      rows.push(`<Row>${cells.join('')}</Row>`);
    }
  }
  return `<Worksheet ss:Name="LeadLag"><Table>${rows.join('')}</Table></Worksheet>`;
}

export function buildXlsXml(dataset, analysis){
  const w1 = buildPricesWorksheetXml(dataset);
  const w2 = buildProcessedWorksheetXml(dataset);
  const w3 = buildLeadLagWorksheetXml(analysis || {rows:[]});
  const xml =
`<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Bottom"/>
      <Borders/>
      <Font/>
      <Interior/>
      <NumberFormat/>
      <Protection/>
    </Style>
  </Styles>
  ${w1}
  ${w2}
  ${w3}
</Workbook>`;
  return xml;
}

export async function saveXls(xml, filename='preise_prozent_leadlag.xls'){
  const blob = new Blob([xml], {type:'application/vnd.ms-excel'});
  const file = new File([blob], filename, {type: 'application/vnd.ms-excel'});

  try{
    if (navigator.canShare && navigator.canShare({ files:[file] })) {
      await navigator.share({
        files: [file],
        title: 'Excel Export',
        text: 'Preise, Prozent & Lead/Lag (3 Reiter)'
      });
      return;
    }
  }catch(_){ /* fallback */ }

  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if(!w){
    const a = Object.assign(document.createElement('a'), {href:url, download:filename});
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}
