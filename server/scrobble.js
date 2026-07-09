// Scrobble resolver. The browser extension scrapes {title, season, episode,
// epName, platform} off a streaming page and POSTs it here; we resolve the show
// and episode against TVmaze (cached), then write the records so the app shows
// it on next sync. Show flags (archived/private) are preserved; platform is set.

'use strict';
const https = require('https');

const showCache = new Map(); // normalized title -> info | null
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function tvmazeGet(path) {
  return new Promise((resolve) => {
    const req = https.get('https://api.tvmaze.com' + path, { headers: { 'User-Agent': 'ShowTrack-scrobble/1.0' } }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

async function resolveShow(title) {
  const key = norm(title);
  if (showCache.has(key)) return showCache.get(key);
  const show = await tvmazeGet('/singlesearch/shows?q=' + encodeURIComponent(title));
  if (!show || !show.id) { showCache.set(key, null); return null; }
  const eps = await tvmazeGet(`/shows/${show.id}/episodes?specials=1`) || [];
  const info = { show, epsBySn: new Map(), epsByName: new Map() };
  for (const e of eps) {
    if (e.number != null) info.epsBySn.set(e.season + ':' + e.number, e);
    if (e.name) info.epsByName.set(norm(e.name), e);
  }
  showCache.set(key, info);
  return info;
}

// st: the user's in-memory state; bump: () => next server seq.
async function handleScrobble(st, body, bump) {
  const { platform, title, season, episode, epName } = body;
  if (!title) return { ok: false, reason: 'no title' };
  const info = await resolveShow(title);
  if (!info) return { ok: false, reason: 'show not found on TVmaze' };

  let ep = null;
  if (season != null && episode != null) ep = info.epsBySn.get(Number(season) + ':' + Number(episode));
  if (!ep && epName) ep = info.epsByName.get(norm(epName));
  if (!ep) return { ok: false, reason: 'episode not matched' };

  const now = Date.now();
  const raw = info.show, sid = raw.id;

  const existing = st.records.shows[sid];
  const show = existing ? { ...existing } : {
    id: sid, name: raw.name,
    image: raw.image ? raw.image.medium : null,
    imageBig: raw.image ? raw.image.original : null,
    status: raw.status, premiered: raw.premiered, ended: raw.ended || null,
    network: (raw.network && raw.network.name) || (raw.webChannel && raw.webChannel.name) || '',
    genres: raw.genres || [], summary: raw.summary || '',
    tvdbId: (raw.externals || {}).thetvdb ?? null, imdbId: (raw.externals || {}).imdb ?? null,
    followedAt: new Date(now).toISOString(), archived: false, private: false, lastEpisodeSync: null,
  };
  if (platform) show.platform = platform;
  show._t = now; show._seq = bump();
  st.records.shows[sid] = show;

  st.records.episodes[ep.id] = {
    id: ep.id, showId: sid, season: ep.season, number: ep.number, name: ep.name,
    airdate: ep.airdate || null, airstamp: ep.airstamp || null, runtime: ep.runtime || null,
    type: ep.type || 'regular', _t: now, _seq: bump(),
  };
  st.records.watched[ep.id] = {
    epId: ep.id, showId: sid, watchedAt: new Date(now).toISOString(),
    progress: 100, source: 'scrobble', _t: now, _seq: bump(),
  };
  return { ok: true, show: raw.name, marked: `S${ep.season}E${ep.number}` };
}

module.exports = { handleScrobble };
