// TMDB client for movie search + posters. The key (v3 api key or v4 bearer
// token — we detect which) lives in on-device settings, never in the repo.

import { kv } from './db.js';

const IMG_BASE = 'https://image.tmdb.org/t/p/';
export const tmdbImg = (path, size = 'w342') => (path ? IMG_BASE + size + path : null);

async function getKey() { return (await kv.get('settings:tmdbKey', '') || '').trim(); }

async function tmdbGet(pathName, params = {}) {
  const key = await getKey();
  if (!key) throw new Error('Add your TMDB key in More → Settings first');
  const url = new URL('https://api.themoviedb.org/3' + pathName);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const opts = { headers: { accept: 'application/json' } };
  if (key.split('.').length === 3) opts.headers.Authorization = 'Bearer ' + key; // v4 JWT
  else url.searchParams.set('api_key', key);                                     // v3 key
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('TMDB ' + res.status);
  return res.json();
}

export const tmdb = {
  hasKey: async () => !!(await getKey()),
  searchMovies: (q) => tmdbGet('/search/movie', { query: q, include_adult: 'true' }),
  externalIds: (id) => tmdbGet(`/movie/${id}/external_ids`),
};
