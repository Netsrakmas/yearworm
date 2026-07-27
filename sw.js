const CACHE_NAME = 'yearworm-4.38.0';
const ASSETS = ['./', './index.html', './manifest.json', './privacy.html', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', event => {
  // bypass the HTTP cache while filling ours — GitHub Pages serves max-age=600,
  // so a plain addAll could seed a stale index.html as the offline copy
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    cache.addAll(ASSETS.map(u => new Request(u, { cache: 'no-cache' })))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Navigations revalidate with the server (bypassing GitHub Pages' 10-minute
  // max-age HTTP cache) so a new deploy shows up on the next open — a 304 when
  // nothing changed keeps this fast. Everything else stays plain network-first.
  const req = event.request.mode === 'navigate'
    ? new Request(event.request, { cache: 'no-cache' })
    : event.request;
  // The index.html fallback is for NAVIGATIONS ONLY: handing HTML to a failed
  // script/audio/API request makes offline launches "glitch" instead of the
  // request failing fast like a normal dropped connection.
  event.respondWith(fetch(req).catch(() => caches.match(event.request).then(cached =>
    cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())
  )));
});

// ---- Web Push: show the notification, and route a tap to the right tab ----
self.addEventListener('push', event => {
  let d = {};
  try{ d = event.data ? event.data.json() : {}; }
  catch(e){ d = { title: 'Yearworm', body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'Yearworm';
  const opts = {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: d.tag,
    data: { tab: d.tab || 'play' },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// the push service rotated/expired our subscription: re-subscribe and re-point
// the server row at the new endpoint, or notifications die silently while the
// app's toggle still says "On"
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const opts = (old && old.options) || { userVisibleOnly: true };
    const sub = await self.registration.pushManager.subscribe(opts);
    await fetch('https://yearworm-api.samkarsten.workers.dev/push-rotate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old: old && old.endpoint, sub: sub.toJSON() }),
    });
  })().catch(() => {}));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || 'play';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of all){
      if('focus' in c){ try{ c.postMessage({ yearwormTab: tab }); }catch(e){} return c.focus(); }
    }
    if(self.clients.openWindow) return self.clients.openWindow('./#tab=' + tab);
  })());
});
