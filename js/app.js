import { db, kv, uuid, exportAll, importAll } from './db.js';
import { tvmaze, normalizeShow, normalizeEpisode } from './api.js';
import { startImportUI } from './import.js';

// ---------- tiny helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only allow http(s) image URLs, escaped for use inside style="...url('…')".
const imgCss = (url) => {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return `background-image:url('${url.replace(/[\\'"()\s]/g, encodeURIComponent)}')`;
};

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtDate(iso) {
  if (!iso) return 'TBA';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function epCode(ep) {
  const s = String(ep.season).padStart(2, '0');
  const n = String(ep.number ?? 0).padStart(2, '0');
  return `S${s}E${n}`;
}
function hasAired(ep, now = Date.now()) {
  if (ep.airstamp) return new Date(ep.airstamp).getTime() <= now;
  if (ep.airdate) return new Date(ep.airdate + 'T23:59:59').getTime() <= now;
  return false; // no date = unaired/TBA
}

// ---------- view switching ----------

const VIEW_TITLES = {
  next: 'Watch Next', upcoming: 'Upcoming', shows: 'My Shows',
  search: 'Search', more: 'More', detail: 'Show', import: 'Import TV Time',
};
let currentView = 'next';
let previousView = 'next';
let currentShowId = null;
let showsFilter = 'watching';

export function switchView(name) {
  if (name !== 'detail' && name !== 'import') previousView = name;
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === name));
  $('#view-title').textContent = VIEW_TITLES[name] || 'ShowTrack';
  window.scrollTo(0, 0);
  render(name);
}

function render(name) {
  if (name === 'next') renderNext();
  else if (name === 'upcoming') renderUpcoming();
  else if (name === 'shows') renderShows();
  else if (name === 'more') renderMore();
  else if (name === 'detail') renderDetail(currentShowId);
}

// ---------- data assembly ----------

async function libraryState() {
  const [shows, episodes, watched] = await Promise.all([
    db.all('shows'), db.all('episodes'), db.all('watched'),
  ]);
  const watchedSet = new Set(watched.map(w => w.epId));
  const lastActivity = {};
  for (const w of watched) {
    const t = w.watchedAt ? new Date(w.watchedAt).getTime() : 0;
    if (!lastActivity[w.showId] || t > lastActivity[w.showId]) lastActivity[w.showId] = t;
  }
  const epsByShow = {};
  for (const e of episodes) (epsByShow[e.showId] ||= []).push(e);
  for (const id in epsByShow)
    epsByShow[id].sort((a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0));
  return { shows, epsByShow, watchedSet, lastActivity };
}

function showProgress(show, epsByShow, watchedSet, now = Date.now()) {
  const eps = (epsByShow[show.id] || []).filter(e => e.type === 'regular' && e.number != null);
  const aired = eps.filter(e => hasAired(e, now));
  const airedWatched = aired.filter(e => watchedSet.has(e.id));
  const nextEp = aired.find(e => !watchedSet.has(e.id)) || null;
  return {
    total: eps.length,
    aired: aired.length,
    watched: airedWatched.length,
    behind: aired.length - airedWatched.length,
    nextEp,
  };
}

// ---------- Watch Next ----------

async function renderNext() {
  const { shows, epsByShow, watchedSet, lastActivity } = await libraryState();
  const items = [];
  for (const show of shows) {
    if (show.archived) continue;
    const p = showProgress(show, epsByShow, watchedSet);
    if (p.nextEp) items.push({ show, ...p, activity: lastActivity[show.id] || 0 });
  }
  items.sort((a, b) => b.activity - a.activity ||
    (b.nextEp.airstamp || '').localeCompare(a.nextEp.airstamp || ''));

  $('#next-empty').classList.toggle('hidden', items.length > 0);
  $('#next-list').innerHTML = items.map(({ show, nextEp, behind }) => `
    <div class="ep-card" data-show="${show.id}">
      <div class="poster" data-open="${show.id}"
           style="${imgCss(show.image)}"></div>
      <div class="body">
        <div class="show-name" data-open="${show.id}">${esc(show.name)}</div>
        <div class="ep-code">${epCode(nextEp)}</div>
        <div class="ep-name">${esc(nextEp.name || '')}</div>
        <div class="ep-date">${fmtDate(nextEp.airdate || nextEp.airstamp)}</div>
        ${behind > 1 ? `<div class="behind">${behind} episodes to watch</div>` : ''}
      </div>
      <div class="actions">
        <button class="check-btn" data-watch="${nextEp.id}" data-watch-show="${show.id}"
                aria-label="Mark watched">&#10003;</button>
      </div>
    </div>`).join('');
}

// ---------- Upcoming ----------

async function renderUpcoming() {
  const { shows, epsByShow, watchedSet } = await libraryState();
  const now = Date.now();
  const horizon = now + 1000 * 60 * 60 * 24 * 90;
  const items = [];
  for (const show of shows) {
    if (show.archived) continue;
    for (const ep of epsByShow[show.id] || []) {
      if (hasAired(ep, now)) continue;
      const t = ep.airstamp ? new Date(ep.airstamp).getTime()
              : ep.airdate ? new Date(ep.airdate + 'T20:00:00').getTime() : null;
      if (t && t <= horizon) items.push({ show, ep, t });
    }
  }
  items.sort((a, b) => a.t - b.t);

  $('#upcoming-empty').classList.toggle('hidden', items.length > 0);
  let lastDay = '';
  $('#upcoming-list').innerHTML = items.map(({ show, ep, t }) => {
    const d = new Date(t);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400000);
    const label = days === 0 ? 'Today' : days === 1 ? 'Tomorrow'
      : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const head = label !== lastDay ? `<div class="day-head">${label}</div>` : '';
    lastDay = label;
    return `${head}
    <div class="ep-card">
      <div class="poster" data-open="${show.id}"
           style="${imgCss(show.image)}"></div>
      <div class="body">
        <div class="show-name" data-open="${show.id}">${esc(show.name)}</div>
        <div class="ep-code">${epCode(ep)}</div>
        <div class="ep-name">${esc(ep.name || '')}</div>
        <div class="ep-date">${fmtDate(ep.airdate || ep.airstamp)}</div>
      </div>
    </div>`;
  }).join('');
}

// ---------- My Shows ----------

async function renderShows() {
  const { shows, epsByShow, watchedSet } = await libraryState();
  const tiles = [];
  for (const show of shows) {
    const p = showProgress(show, epsByShow, watchedSet);
    let bucket;
    if (show.archived) bucket = 'all';
    else if (p.behind > 0) bucket = 'watching';
    else if (show.status === 'Ended') bucket = 'ended';
    else bucket = 'done';
    if (showsFilter !== 'all' && bucket !== showsFilter) continue;
    tiles.push({ show, p, bucket });
  }
  tiles.sort((a, b) => a.show.name.localeCompare(b.show.name));

  $('#shows-empty').classList.toggle('hidden', shows.length > 0);
  $('#shows-grid').innerHTML = tiles.map(({ show, p }) => {
    const pct = p.aired ? Math.round(100 * p.watched / p.aired) : 0;
    const sub = show.archived ? 'Stopped'
      : p.behind > 0 ? `${p.behind} left` : (show.status === 'Ended' ? 'Finished' : 'Up to date');
    return `
    <div class="show-tile" data-open="${show.id}">
      <div class="poster" style="${imgCss(show.image)}">
        <div class="prog"><div style="width:${pct}%"></div></div>
      </div>
      <div class="t-name">${esc(show.name)}</div>
      <div class="t-sub">${sub} &middot; ${p.watched}/${p.aired}</div>
    </div>`;
  }).join('');
}

// ---------- Search ----------

let searchTimer = null;
async function doSearch(q) {
  if (!q.trim()) { $('#search-results').innerHTML = ''; return; }
  let results;
  try { results = await tvmaze.search(q.trim()); }
  catch (e) { toast('Search failed — are you online?'); return; }
  const followed = new Set((await db.all('shows')).map(s => s.id));
  $('#search-results').innerHTML = results.map(({ show }) => {
    const year = show.premiered ? show.premiered.slice(0, 4) : '';
    const net = show.network?.name || show.webChannel?.name || '';
    const isF = followed.has(show.id);
    return `
    <div class="result-card">
      <div class="poster" style="${imgCss(show.image && show.image.medium)}"></div>
      <div class="body">
        <h3>${esc(show.name)}</h3>
        <div class="sub">${[year, net, show.status].filter(Boolean).map(esc).join(' &middot; ')}</div>
        <div class="sub">${(show.genres || []).slice(0, 3).map(esc).join(', ')}</div>
      </div>
      <div class="actions">
        <button class="follow-btn ${isF ? 'following' : ''}" data-follow="${show.id}">
          ${isF ? 'Following' : '+ Follow'}</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted center">No results.</p>';
}

async function followShow(tvmazeId) {
  const existing = await db.get('shows', tvmazeId);
  if (existing) { toast('Already following'); return; }
  const raw = await tvmaze.show(tvmazeId);
  const show = { ...normalizeShow(raw), followedAt: new Date().toISOString(), archived: false, lastEpisodeSync: null };
  await db.put('shows', show);
  toast(`Following ${show.name}`);
  syncShowEpisodes(tvmazeId).then(() => { if (currentView === 'next') renderNext(); });
}

// ---------- episode sync ----------

export async function syncShowEpisodes(showId) {
  const eps = await tvmaze.episodes(showId);
  await db.putMany('episodes', eps.map(e => normalizeEpisode(e, showId)));
  const show = await db.get('shows', showId);
  if (show) { show.lastEpisodeSync = new Date().toISOString(); await db.put('shows', show); }
  return eps.length;
}

async function syncStaleShows({ force = false } = {}) {
  const shows = await db.all('shows');
  const dayAgo = Date.now() - 86400000;
  const stale = shows.filter(s => {
    if (!s.lastEpisodeSync) return true;
    if (force) return s.status !== 'Ended';
    return s.status !== 'Ended' && new Date(s.lastEpisodeSync).getTime() < dayAgo;
  });
  if (!stale.length) return 0;
  for (const s of stale) {
    try { await syncShowEpisodes(s.id); } catch (e) { console.warn('sync failed', s.name, e); }
  }
  return stale.length;
}

// ---------- watched toggling ----------

async function markWatched(epId, showId) {
  await db.put('watched', { epId, showId, watchedAt: new Date().toISOString(), source: 'app' });
}
async function unmarkWatched(epId) { await db.del('watched', epId); }

// ---------- Show detail ----------

async function renderDetail(showId) {
  const show = await db.get('shows', showId);
  if (!show) { switchView(previousView); return; }
  const [eps, watchedRows] = await Promise.all([
    db.allByIndex('episodes', 'showId', showId),
    db.allByIndex('watched', 'showId', showId),
  ]);
  const watchedSet = new Set(watchedRows.map(w => w.epId));
  eps.sort((a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0));
  const seasons = {};
  for (const e of eps) { if (e.type === 'regular' && e.number != null) (seasons[e.season] ||= []).push(e); }
  const now = Date.now();
  const p = showProgress(show, { [showId]: eps }, watchedSet, now);

  $('#detail-content').innerHTML = `
    <button class="back-btn" id="detail-back">&#8592; Back</button>
    <div class="detail-hero">
      <div class="poster" style="${imgCss(show.image)}"></div>
      <div class="info">
        <h2>${esc(show.name)}</h2>
        <div class="sub">${[show.network, show.status, show.premiered?.slice(0, 4)].filter(Boolean).map(esc).join(' &middot; ')}</div>
        <div class="sub">${p.watched}/${p.aired} episodes watched${p.behind ? ` &middot; <b style="color:var(--accent)">${p.behind} left</b>` : ''}</div>
        <div class="detail-actions">
          <button class="pill-btn" id="detail-sync">&#8635; Update episodes</button>
          <button class="pill-btn" id="detail-archive">${show.archived ? '&#9654; Resume watching' : '&#9208; Stop watching'}</button>
          <button class="pill-btn warn" id="detail-unfollow">Remove show</button>
        </div>
      </div>
    </div>
    ${Object.entries(seasons).map(([sn, list]) => {
      const w = list.filter(e => watchedSet.has(e.id)).length;
      const airedList = list.filter(e => hasAired(e, now));
      const allDone = airedList.length > 0 && airedList.every(e => watchedSet.has(e.id));
      return `
      <div class="season-block" data-season="${sn}">
        <div class="season-head" data-toggle="${sn}">
          <span>Season ${sn} <span class="s-sub">${w}/${list.length}</span></span>
          <button class="season-mark" data-season-mark="${sn}" ${allDone ? 'disabled' : ''}>
            ${allDone ? 'All watched' : 'Mark season'}</button>
        </div>
        <div class="season-eps hidden">
          ${list.map(e => `
          <div class="ep-row ${hasAired(e, now) ? '' : 'future'}">
            <span class="num">${e.number}</span>
            <span class="nm">${esc(e.name || 'Episode ' + e.number)}</span>
            <span class="dt">${fmtDate(e.airdate)}</span>
            <button class="mini-check ${watchedSet.has(e.id) ? 'done' : ''}"
                    data-ep-toggle="${e.id}" aria-label="Toggle watched">&#10003;</button>
          </div>`).join('')}
        </div>
      </div>`;
    }).join('')}`;

  $('#detail-back').onclick = () => switchView(previousView);
  $('#detail-sync').onclick = async () => {
    toast('Updating…');
    try { await syncShowEpisodes(showId); toast('Episodes updated'); renderDetail(showId); }
    catch { toast('Update failed'); }
  };
  $('#detail-archive').onclick = async () => {
    show.archived = !show.archived;
    await db.put('shows', show);
    toast(show.archived ? 'Stopped watching' : 'Resumed');
    renderDetail(showId);
  };
  $('#detail-unfollow').onclick = async () => {
    if (!confirm(`Remove "${show.name}" and its watch history from your library?`)) return;
    const epIds = eps.map(e => e.id);
    await db.delMany('episodes', epIds);
    await db.delMany('watched', epIds.filter(id => watchedSet.has(id)));
    await db.del('shows', showId);
    toast('Removed');
    switchView(previousView);
  };

  // onclick assignment (not addEventListener) so re-renders don't stack handlers
  $('#detail-content').onclick = async (ev) => {
    const t = ev.target;
    if (t.dataset.seasonMark) {
      const sn = Number(t.dataset.seasonMark);
      const list = (seasons[sn] || []).filter(e => hasAired(e, now) && !watchedSet.has(e.id));
      const ts = new Date().toISOString();
      await db.putMany('watched', list.map(e => ({ epId: e.id, showId, watchedAt: ts, source: 'app' })));
      toast(`Season ${sn}: ${list.length} marked watched`);
      renderDetail(showId);
      return;
    }
    if (t.dataset.epToggle) {
      const epId = Number(t.dataset.epToggle);
      if (t.classList.contains('done')) { await unmarkWatched(epId); t.classList.remove('done'); }
      else { await markWatched(epId, showId); t.classList.add('done'); }
      return;
    }
    const head = t.closest('.season-head');
    if (head) head.nextElementSibling.classList.toggle('hidden');
  };
}

export function openShow(showId) {
  currentShowId = Number(showId);
  switchView('detail');
}

// ---------- More: stats, movies, watchlist ----------

async function renderMore() {
  const [shows, watched, episodes, movies, watchlist] = await Promise.all([
    db.all('shows'), db.all('watched'), db.all('episodes'), db.all('movies'), db.all('watchlist'),
  ]);
  const epRuntime = new Map(episodes.map(e => [e.id, e.runtime || 40]));
  let minutes = 0;
  for (const w of watched) minutes += epRuntime.get(w.epId) || 40;
  const days = (minutes / 60 / 24).toFixed(1);

  $('#stats').innerHTML = `
    <div class="stat"><div class="num">${shows.length}</div><div class="lbl">shows</div></div>
    <div class="stat"><div class="num">${watched.length.toLocaleString()}</div><div class="lbl">episodes watched</div></div>
    <div class="stat"><div class="num">${days}</div><div class="lbl">days of TV</div></div>
    <div class="stat"><div class="num">${movies.length}</div><div class="lbl">movies</div></div>`;

  const recentMovies = movies
    .sort((a, b) => (b.watchedAt || '').localeCompare(a.watchedAt || '')).slice(0, 15);
  $('#movies-list').innerHTML = recentMovies.map(m => `
    <div class="simple-row"><span>${esc(m.title)}</span>
      <span class="when">${m.watchedAt ? fmtDate(m.watchedAt) : ''}</span></div>`).join('')
    || '<p class="muted small">No movies yet (they import from TV Time).</p>';
  if (movies.length > 15)
    $('#movies-list').innerHTML += `<p class="muted small center">…and ${movies.length - 15} more</p>`;

  $('#watchlist-list').innerHTML = watchlist.map(w => `
    <div class="simple-row"><span>${esc(w.title)}</span>
      <span class="when">${w.type}</span></div>`).join('')
    || '<p class="muted small">Watchlist is empty.</p>';
}

// ---------- backup / restore ----------

async function downloadBackup() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `showtrack-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Backup downloaded');
}

// ---------- global event wiring ----------

document.querySelectorAll('#tabbar .tab').forEach(t =>
  t.addEventListener('click', () => switchView(t.dataset.view)));

document.querySelectorAll('.seg').forEach(s => s.addEventListener('click', () => {
  document.querySelectorAll('.seg').forEach(x => x.classList.remove('active'));
  s.classList.add('active');
  showsFilter = s.dataset.filter;
  renderShows();
}));

$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(e.target.value), 400);
});

document.body.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.dataset.open) { openShow(t.dataset.open); return; }
  if (t.dataset.follow) {
    const id = Number(t.dataset.follow);
    t.disabled = true;
    try { await followShow(id); t.textContent = 'Following'; t.classList.add('following'); }
    catch { toast('Could not follow — try again'); }
    t.disabled = false;
    return;
  }
  if (t.dataset.watch) {
    const epId = Number(t.dataset.watch);
    const showId = Number(t.dataset.watchShow);
    t.classList.add('done');
    await markWatched(epId, showId);
    setTimeout(renderNext, 350); // brief tick animation, then show the next episode
    return;
  }
});

$('#btn-refresh').addEventListener('click', async () => {
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  try {
    if (currentView === 'detail' && currentShowId) await syncShowEpisodes(currentShowId);
    else {
      const n = await syncStaleShows({ force: true });
      toast(n ? `Updated ${n} shows` : 'Everything is current');
    }
    render(currentView);
  } catch { toast('Refresh failed'); }
  btn.classList.remove('spinning');
});

$('#btn-backup').addEventListener('click', downloadBackup);
$('#btn-restore').addEventListener('click', () => $('#file-restore').click());
$('#file-restore').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!confirm('Replace everything in the app with this backup?')) return;
    await importAll(data);
    toast('Backup restored');
    render(currentView);
  } catch (err) { toast('Restore failed: ' + err.message); }
  e.target.value = '';
});

$('#btn-import-tvtime').addEventListener('click', () => $('#file-tvtime').click());
$('#file-tvtime').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  switchView('import');
  startImportUI(files, $('#import-content'), {
    onDone: () => { toast('Import complete!'); switchView('shows'); },
    onBack: () => switchView('more'),
  });
  e.target.value = '';
});

// ---------- boot ----------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  await renderNext();
  // background: refresh stale running shows once per day
  syncStaleShows().then(n => { if (n && currentView === 'next') renderNext(); });
})();
