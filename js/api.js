// TVmaze API client. Free, no API key. Rate limit: ~20 requests / 10 s,
// so every call goes through a queue that spaces requests and retries on 429.

const BASE = 'https://api.tvmaze.com';
const MIN_GAP_MS = 550;

let lastRequest = 0;
let chain = Promise.resolve();

function throttled(fn) {
  const p = chain.then(async () => {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequest = Date.now();
    return fn();
  });
  // keep the chain alive even if a request fails
  chain = p.catch(() => {});
  return p;
}

async function get(path, { allow404 = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await throttled(() => fetch(BASE + path));
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`TVmaze ${res.status} for ${path}`);
    return res.json();
  }
  throw new Error(`TVmaze rate limit — gave up on ${path}`);
}

export const tvmaze = {
  search: (q) => get(`/search/shows?q=${encodeURIComponent(q)}`),
  show: (id) => get(`/shows/${id}`),
  episodes: (id) => get(`/shows/${id}/episodes?specials=1`),
  byTvdb: (tvdbId) => get(`/lookup/shows?thetvdb=${tvdbId}`, { allow404: true }),
  byImdb: (imdbId) => get(`/lookup/shows?imdb=${imdbId}`, { allow404: true }),
};

export function normalizeShow(raw) {
  return {
    id: raw.id,
    name: raw.name,
    image: raw.image ? raw.image.medium : null,
    imageBig: raw.image ? raw.image.original : null,
    status: raw.status,                    // Running | Ended | To Be Determined …
    premiered: raw.premiered,
    ended: raw.ended,
    network: raw.network?.name || raw.webChannel?.name || '',
    genres: raw.genres || [],
    summary: raw.summary || '',
    tvdbId: raw.externals?.thetvdb ?? null,
    imdbId: raw.externals?.imdb ?? null,
  };
}

export function normalizeEpisode(raw, showId) {
  return {
    id: raw.id,
    showId,
    season: raw.season,
    number: raw.number,
    name: raw.name,
    airdate: raw.airdate || null,
    airstamp: raw.airstamp || null,
    runtime: raw.runtime || null,
    type: raw.type || 'regular',
  };
}
