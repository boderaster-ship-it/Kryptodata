// Minimal IndexedDB helper
const DB_NAME = 'capture-db';
const STORE = 'cache-v1';
const openDB = () => new Promise((res,rej)=>{
  const r = indexedDB.open(DB_NAME,1);
  r.onupgradeneeded = ()=> r.result.createObjectStore(STORE);
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
});
async function idbGet(key){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readonly'); const req=tx.objectStore(STORE).get(key); req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); }); }
async function idbSet(key,val){ const db=await openDB(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(val,key); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }

export async function cacheGet(key, maxAgeMs){
  const rec = await idbGet(key);
  if(!rec) return null;
  if(maxAgeMs && Date.now()-rec.t > maxAgeMs) return null;
  return rec.v;
}
export async function cacheSet(key, value){
  await idbSet(key, {t:Date.now(), v:value});
}
export function k(obj){ return JSON.stringify(obj); } // stable key
