/* Release cache only. User records live in localStorage/IndexedDB and are never
 * read, migrated, or deleted here. Bump VERSION whenever any precached byte changes. */
'use strict';
const VERSION = 'encrypted-0da8bea0ec03c2a2';
const SCOPE = self.registration.scope;
const CACHE_PREFIX = `travel-handbook:${encodeURIComponent(SCOPE)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const ASSETS = ["index.html","unlock.js","payload.json","manifest.json","icon-192.png","icon-512.png","apple-touch-icon.png","encrypted-054ff59b66cb3bee0220e61faff812b1ff4cdc100e10ec0fdb9c93f0beaa2f2e.bin","encrypted-52ccb1111eb5fdfea8695a0fe5bc476600f1c5e1b5fc072c1e81e0c567abd4a7.bin","encrypted-017ebfc63e4fed4048cd7a011780a84c65ed3acf94647c2bd219d01d312213a3.bin","encrypted-0fe5ca24be12d7f146393b2d44cf4055b549dc0489c515147a65dd70cac4b1c1.bin","encrypted-c4fc2bd983d1e82ae983e3d39abfa6f2b262bbf25db5afb79f01b11e6f49b1cb.bin","encrypted-ee66838173032ea1a4fec80ce39fa611cce41ad0e322438e2e63b9b522a81e45.bin","encrypted-eb7d790e2658274cbda597d03211742bb86fc6028ee8e4bc46e6b6f232b34ee8.bin"];
const ASSET_URLS = ASSETS.map(path => new URL(path, SCOPE).href);
const INDEX_URL = ASSET_URLS[0];

async function cacheStatus(requestId) {
  const exists = await caches.has(CACHE_NAME);
  const cache = exists ? await caches.open(CACHE_NAME) : null;
  const assets = await Promise.all(ASSETS.map(async (path, index) => {
    const response = cache ? await cache.match(ASSET_URLS[index]) : null;
    return { path, cached: Boolean(response && response.ok), status: response ? response.status : null };
  }));
  const missing = assets.filter(asset => !asset.cached).map(asset => asset.path);
  return {
    type: 'CACHE_STATUS', requestId: requestId == null ? null : requestId,
    version: VERSION, cacheName: CACHE_NAME, scope: SCOPE,
    complete: missing.length === 0,
    cachedCount: assets.length - missing.length, totalCount: assets.length,
    missing, assets
  };
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if (client.url.startsWith(SCOPE)) client.postMessage(message);
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const existed = await caches.has(CACHE_NAME);
    // A different worker script may not overwrite an active release's cache.
    if (existed && self.registration.active) {
      throw new Error('Release version already exists; bump VERSION before publishing changed assets.');
    }
    try {
      const cache = await caches.open(CACHE_NAME);
      // Cache.addAll is all-or-nothing: failed/opaque/HTTP error responses reject
      // installation. cache:reload prevents a stale HTTP cache mixing releases.
      await cache.addAll(ASSET_URLS.map(url => new Request(url, { cache: 'reload', credentials: 'same-origin' })));
      const status = await cacheStatus();
      if (!status.complete) throw new Error(`Incomplete offline package: ${status.missing.join(', ')}`);
      await notifyClients(status);
      // No skipWaiting here. A waiting update is applied only after an explicit
      // user-confirmed message, or the browser's normal no-clients lifecycle.
    } catch (error) {
      if (!existed) await caches.delete(CACHE_NAME);
      await notifyClients({ type: 'CACHE_INSTALL_FAILED', version: VERSION, error: String(error.message || error) });
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const status = await cacheStatus();
    if (!status.complete) throw new Error('Cannot activate an incomplete offline package.');
    // Only this handbook scope's old static releases are removed. Never clear
    // all origin caches, localStorage, IndexedDB, attachments, or user records.
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
    await notifyClients(status);
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  const reply = message => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(message);
    else if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(message);
  };
  if (data.type === 'GET_CACHE_STATUS') {
    event.waitUntil(cacheStatus(data.requestId).then(reply).catch(error => reply({
      type: 'CACHE_STATUS', requestId: data.requestId == null ? null : data.requestId,
      version: VERSION, cacheName: CACHE_NAME, scope: SCOPE, complete: false,
      cachedCount: 0, totalCount: ASSETS.length, missing: ASSETS.slice(), assets: [],
      error: String(error.message || error)
    })));
  } else if (data.type === 'SKIP_WAITING') {
    event.waitUntil((async () => {
      const status = await cacheStatus(data.requestId);
      if (data.userConfirmed !== true || !status.complete) {
        reply({ type: 'UPDATE_NOT_APPLIED', version: VERSION, reason: data.userConfirmed !== true ? 'user-confirmation-required' : 'cache-incomplete' });
        return;
      }
      reply({ type: 'UPDATE_APPLYING', version: VERSION, requestId: data.requestId == null ? null : data.requestId });
      await self.skipWaiting();
    })());
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(INDEX_URL);
      if (cached) return cached;
      // Missing cache can happen after OS storage eviction. Do not pretend the
      // package remains offline-ready or silently replace one release asset.
      try { return await fetch(request); }
      catch (_) {
        return new Response('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需要重新保存离线手册</title><body><h1>离线文件暂不可用</h1><p>请恢复网络后重新打开手册，等待“离线就绪”。已有旅行记录与记账数据未被主动清除。</p></body></html>', {
          status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
    })());
    return;
  }
  const key = new URL(url.href);
  key.search = '';
  key.hash = '';
  if (!ASSET_URLS.includes(key.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(key.href) || fetch(request);
  })());
});
