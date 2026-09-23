/* Release cache only. User records live in localStorage/IndexedDB and are never
 * read, migrated, or deleted here. Bump VERSION whenever any precached byte changes. */
'use strict';
const VERSION = 'encrypted-3d873e0811d108ad';
const SCOPE = self.registration.scope;
const CACHE_PREFIX = `travel-handbook:${encodeURIComponent(SCOPE)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const ASSETS = ["index.html","unlock.js","payload.json","manifest.json","icon-192.png","icon-512.png","apple-touch-icon.png","encrypted-0ba0a66b80641dfc7c81e37955a09d7a70a7a1983c32f217a2d98c9fc8aa81b1.bin","encrypted-7e1fde22ed138a27290260cf31a8045505c5db2985b108724288f7ca8c5eb2a4.bin","encrypted-8c0ebdf10394183210d5f2926d3eb30d315435a80d6459b6e79da07b3466be68.bin","encrypted-ca40e14294fa42994dcb6c99e56c81d3edaede151e7d87237e92bb73c84980c5.bin","encrypted-3758a7826bff7dd902f195c9d5e510c803c39a1cce730a75999ab5d11111fc90.bin","encrypted-586f00ef4f7dbf30f62163ce55f21ad99473799613585f831be3cc6ab01c543c.bin","encrypted-80bfa68823bd46948a77cbd2c14ddb744e5281fb403804a460b84271c5991ba4.bin"];
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
