const CACHE = 'static-v1';
const ASSETS = [
  './','./index.html','./style.css','./app.js','./providers.js','./storage.js','./export.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
});
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  if (ASSETS.includes(url.pathname) || url.origin===location.origin){
    e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request)));
  }
});
