// Sync client. Pushes local changes to the ShowTrack server and pulls remote
// ones, so every signed-in device converges to the same library.
// Device-local state (server URL, token, watermarks) lives in localStorage.

import { db, SYNC_STORES, local } from './db.js';

const CHUNK = 5000;

export const sync = {
  server: () => local.get('sync:server', ''),
  token: () => local.get('sync:token', ''),
  username: () => local.get('sync:username', ''),
  configured: () => !!(local.get('sync:server') && local.get('sync:token')),
  lastSyncAt: () => local.get('sync:lastAt', 0),
};

async function api(pathName, body) {
  const base = local.get('sync:server', '').replace(/\/$/, '');
  if (!base) throw new Error('No server set');
  const res = await fetch(base + pathName, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

export async function registerAccount(server, username, password) {
  local.set('sync:server', server);
  const r = await api('/api/register', { username, password });
  local.set('sync:token', r.token); local.set('sync:username', r.username);
  return r;
}
export async function loginAccount(server, username, password) {
  local.set('sync:server', server);
  const r = await api('/api/login', { username, password });
  local.set('sync:token', r.token); local.set('sync:username', r.username);
  return r;
}
export function signOut() {
  local.del('sync:token'); local.del('sync:username');
  local.del('sync:lastPushT'); local.del('sync:lastPullSince'); local.del('sync:lastAt');
}

// Push everything changed since our last push watermark.
async function push(token, onProgress) {
  const sinceT = local.get('sync:lastPushT', 0);
  let maxT = sinceT;
  const tombs = await db.tombstonesSince(sinceT);
  const tombByStore = {};
  for (const t of tombs) { (tombByStore[t.store] = tombByStore[t.store] || []).push(t); if (t._t > maxT) maxT = t._t; }

  for (const store of SYNC_STORES) {
    let recs = await db.changedSince(store, sinceT);
    if (store === 'kv') recs = recs.filter(r => !String(r.k).startsWith('avail:')); // device caches don't sync
    const deletes = tombByStore[store] || [];
    if (!recs.length && !deletes.length) continue;
    for (const r of recs) if (r._t > maxT) maxT = r._t;

    // chunk records; attach deletes to the first chunk
    let sentDeletes = false;
    for (let i = 0; i < recs.length || !sentDeletes; i += CHUNK) {
      const slice = recs.slice(i, i + CHUNK);
      await api('/api/push', {
        token, store, records: slice,
        deletes: sentDeletes ? [] : deletes.map(d => ({ id: d.id, _t: d._t })),
      });
      sentDeletes = true;
      onProgress && onProgress(`Uploading ${store}…`);
      if (i + CHUNK >= recs.length) break;
    }
  }
  local.set('sync:lastPushT', maxT);
}

// Pull everything the server has that we haven't seen, newest merge wins.
async function pull(token, onProgress) {
  let since = local.get('sync:lastPullSince', 0);
  let maxAppliedT = 0, pages = 0;
  for (;;) {
    const r = await api('/api/pull', { token, since });
    // group deletes by store, then apply each store's page in a single transaction
    const delByStore = {};
    for (const d of r.deletes || []) {
      (delByStore[d.store] = delByStore[d.store] || []).push(d);
      if ((d._t || 0) > maxAppliedT) maxAppliedT = d._t;
    }
    const stores = new Set([...Object.keys(r.records || {}), ...Object.keys(delByStore)]);
    for (const store of stores) {
      const recs = (r.records && r.records[store]) || [];
      for (const rec of recs) if ((rec._t || 0) > maxAppliedT) maxAppliedT = rec._t;
      await db.applyBatch(store, recs, delByStore[store] || []);
    }
    since = r.nextSince;
    local.set('sync:lastPullSince', since);
    pages++;
    onProgress && onProgress(`Downloading… (${pages})`);
    if (!r.more) break;
  }
  // don't re-push what we just pulled
  const lastPush = local.get('sync:lastPushT', 0);
  if (maxAppliedT > lastPush) local.set('sync:lastPushT', maxAppliedT);
}

let syncing = false;
export async function syncNow(onProgress = null) {
  if (!sync.configured()) throw new Error('Not signed in to a server');
  if (syncing) return { skipped: true };
  syncing = true;
  const token = local.get('sync:token');
  try {
    await push(token, onProgress);
    await pull(token, onProgress);
    local.set('sync:lastAt', Date.now());
    return { ok: true };
  } finally { syncing = false; }
}

export async function fetchAlerts() {
  if (!sync.configured()) return [];
  const r = await api('/api/alerts', { token: local.get('sync:token') });
  return r.alerts || [];
}
export async function clearAlerts() {
  if (!sync.configured()) return;
  await api('/api/alerts/clear', { token: local.get('sync:token') });
}
