function toCsvRow(arr){
  return arr.map(v=>{
    if (v===null||v===undefined) return '';
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(';'); // DE Excel: Semikolon
}

export function buildCsv(dataset){
  // dataset = { timestamps:[...], series:[{label, values:[...]}], intervalLabel, count }
  const lines = [];
  // Zeile 1: Header (optional „Zeit“ über jedem Zeit-Bucket)
  lines.push(toCsvRow(['', ...dataset.timestamps.map(()=> 'Zeit')]));
  // Zeile 2: A2 = Anzahl; ab B2 die Zeitstempel (ISO)
  lines.push(toCsvRow([dataset.count, ...dataset.timestamps.map(ts=> new Date(ts).toISOString())]));
  // Ab Zeile 3: je Asset eine Zeile
  for (const s of dataset.series){
    lines.push(toCsvRow([s.label, ...s.values]));
  }
  return lines.join('\n');
}

// iPhone/Tablet/Browser: primär Share-Sheet („In Dateien sichern“), sonst Tab öffnen, sonst Download
export async function saveCsv(csv, filename='preise_export.csv'){
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
  // Versuch: neue Tab-Ansicht (Safari zeigt dann „Teilen“/„In Dateien sichern“)
  const w = window.open(url, '_blank');
  if(!w){
    // Letzter Fallback: klassischer Download
    const a = Object.assign(document.createElement('a'), {href:url, download:filename});
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}

// Zusätzlicher Direkt-Download (für Laptop/Desktop), ohne Share-Sheet
export function downloadCsvDirect(csv, filename='preise_export.csv'){
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {href:url, download:filename});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}
