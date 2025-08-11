function toCsvRow(arr){ return arr.map(v=>{
  if (v===null||v===undefined) return '';
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}).join(';'); // DE Excel: ; als Trenner
}

export function buildCsv(dataset){
  // dataset = { timestamps:[...], series:[{label, values:[...]}], intervalLabel, count }
  const lines = [];
  // Row1: Header (wir lassen A1 leer und beginnen ab B1 optional mit "Zeit")
  lines.push(toCsvRow(['', ...dataset.timestamps.map(()=> 'Zeit')]));
  // Row2: A2 = Anzahl; ab B2 Zeitlabel
  lines.push(toCsvRow([dataset.count, ...dataset.timestamps.map(ts=> new Date(ts).toISOString())]));
  // Ab Zeile 3: je Asset eine Zeile
  for (const s of dataset.series){
    lines.push(toCsvRow([s.label, ...s.values]));
  }
  return lines.join('\n');
}

export function downloadCsv(csv, filename='preise_export.csv'){
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {href:url, download:filename});
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
