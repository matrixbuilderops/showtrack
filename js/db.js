// IndexedDB data layer. All user data lives here, on-device.
// Stores:
//   shows     { id (tvmaze), name, image, status, premiered, network, tvdbId, imdbId,
//               genres, followedAt, archived, lastEpisodeSync }
//   episodes  { id (tvmaze ep), showId, season, number, name, airdate, airstamp, runtime, type }
//   watched   { epId, showId, watchedAt, source }
//   movies    { id (uuid), title, imdbId, watchedAt, rating, source }
//   watchlist { id (uuid), type, title, tvmazeId, imdbId, addedAt }
//   kv        { k, v }

const DB_NAME = 'showtrack';
const DB_VERSION = 2;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (s) => db.objectStoreNames.contains(s);
      if (!has('shows')) db.createObjectStore('shows', { keyPath: 'id' });
      if (!has('episodes')) {
        const eps = db.createObjectStore('episodes', { keyPath: 'id' });
        eps.createIndex('showId', 'showId');
      }
      if (!has('watched')) {
        const w = db.createObjectStore('watched', { keyPath: 'epId' });
        w.createIndex('showId', 'showId');
      }
      if (!has('movies')) db.createObjectStore('movies', { keyPath: 'id' });
      if (!has('watchlist')) db.createObjectStore('watchlist', { keyPath: 'id' });
      if (!has('lists')) db.createObjectStore('lists', { keyPath: 'id' });
      if (!has('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqAsPromise(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

export const db = {
  get: (store, key) => reqAsPromise(store, 'readonly', s => s.get(key)),
  all: (store) => reqAsPromise(store, 'readonly', s => s.getAll()),
  allByIndex: (store, index, value) =>
    reqAsPromise(store, 'readonly', s => s.index(index).getAll(value)),
  put: (store, obj) => tx(store, 'readwrite', s => s.put(obj)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', s => s.clear()),
  count: (store) => reqAsPromise(store, 'readonly', s => s.count()),
  // Bulk write in a single transaction — critical for import performance.
  putMany: (store, objs) => tx(store, 'readwrite', s => { for (const o of objs) s.put(o); }),
  delMany: (store, keys) => tx(store, 'readwrite', s => { for (const k of keys) s.delete(k); }),
};

export const kv = {
  get: (k, dflt = null) => db.get('kv', k).then(r => (r ? r.v : dflt)),
  set: (k, v) => db.put('kv', { k, v }),
  del: (k) => db.del('kv', k),
};

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxx-xxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

// ---- backup / restore ----

const ALL_STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];

export async function exportAll() {
  const out = { app: 'showtrack', version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const s of ALL_STORES) out[s] = await db.all(s);
  return out;
}

export async function importAll(data, { merge = false } = {}) {
  if (!data || data.app !== 'showtrack') throw new Error('Not a ShowTrack backup file');
  for (const s of ALL_STORES) {
    if (!Array.isArray(data[s])) continue;
    if (!merge) await db.clear(s);
    await db.putMany(s, data[s]);
  }
}
