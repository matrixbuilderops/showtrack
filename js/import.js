// TV Time GDPR-export importer.
// Accepts the export ZIP directly (parsed in-browser, no libraries) or loose CSVs.
// The export schema is not officially documented, so columns are detected
// heuristically and everything unrecognized ends up in a downloadable report
// instead of being silently dropped.

import { db, kv, uuid } from './db.js';
import { tvmaze, normalizeShow, normalizeEpisode } from './api.js';

// ---------- minimal ZIP reader (store + deflate via DecompressionStream) ----------

async function unzip(file) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  // find End Of Central Directory record
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
    entries.push({ name, method, csize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const files = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    if (e.csize === 0xFFFFFFFF) throw new Error('ZIP64 not supported — unzip it first and select the CSV files');
    const lNameLen = dv.getUint16(e.localOff + 26, true);
    const lExtraLen = dv.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + lNameLen + lExtraLen;
    const bytes = new Uint8Array(buf, start, e.csize);
    let text;
    if (e.method === 0) {
      text = new TextDecoder().decode(bytes);
    } else if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      text = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
    } else {
      continue; // unsupported method — skip
    }
    files.push({ name: e.name, text });
  }
  return files;
}

// ---------- CSV parser (RFC 4180: quotes, embedded commas/newlines) ----------

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { headers, records };
}

// ---------- column detection ----------

function findCol(headers, patterns) {
  const lower = headers.map(h => h.toLowerCase());
  for (const p of patterns) {
    const i = lower.findIndex(h => p.test(h));
    if (i >= 0) return headers[i];
  }
  return null;
}

function detectFields(headers) {
  return {
    entityType: findCol(headers, [/^entity[-_ ]?type$/, /^type$/]),
    seriesId:   findCol(headers, [/^series[-_ ]?id$/, /^(tv[-_ ]?)?show[-_ ]?id$/, /tvdb.*series/, /series.*tvdb/]),
    episodeId:  findCol(headers, [/^episode[-_ ]?id$/, /tvdb.*episode/]),
    movieId:    findCol(headers, [/^movie[-_ ]?id$/]),
    imdbId:     findCol(headers, [/imdb/]),
    season:     findCol(headers, [/^season([-_ ]?(number|num))?$/, /season/]),
    epNumber:   findCol(headers, [/^episode[-_ ]?(number|num)$/, /^(ep[-_ ]?)?number$/, /episode.*number/]),
    title:      findCol(headers, [/^(series|show)[-_ ]?name$/, /^tv[-_ ]?show[-_ ]?name$/, /^title$/, /^name$/, /name|title/]),
    watchedAt:  findCol(headers, [/watched[-_ ]?(at|date|on)/, /^created[-_ ]?at$/, /^date$/, /updated[-_ ]?at/]),
    rating:     findCol(headers, [/rating/]),
    status:     findCol(headers, [/^status$/, /watch.*status/, /list/]),
  };
}

function classifyRow(row, f) {
  const et = f.entityType ? (row[f.entityType] || '').toLowerCase() : '';
  const hasEp = (f.season && row[f.season] !== '') || (f.episodeId && row[f.episodeId] !== '');
  if (et.includes('movie') || (f.movieId && row[f.movieId] !== '' && !hasEp)) return 'movie';
  if (et.includes('episode') || hasEp) return 'episode';
  if (et.includes('series') || et.includes('show')) return 'follow';
  if (f.seriesId && row[f.seriesId] !== '') return 'follow';
  return 'unknown';
}

// ---------- import engine ----------

export async function analyzeFiles(files) {
  const csvs = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const inner = await unzip(file);
      for (const f of inner) {
        if (f.name.toLowerCase().endsWith('.csv')) csvs.push({ name: f.name, text: f.text });
        else if (f.name.toLowerCase().endsWith('.json')) csvs.push({ name: f.name, text: f.text, json: true });
      }
    } else {
      csvs.push({ name: file.name, text: await file.text() });
    }
  }

  const episodes = [], movies = [], follows = [], unknown = [];
  const analyzed = [];
  for (const c of csvs) {
    if (c.json) { analyzed.push({ name: c.name, note: 'JSON file — kept for reference, not imported', rows: 0 }); continue; }
    const { headers, records } = parseCSV(c.text);
    if (!records.length) { analyzed.push({ name: c.name, note: 'empty', rows: 0 }); continue; }
    const f = detectFields(headers);
    const counts = { episode: 0, movie: 0, follow: 0, unknown: 0 };
    for (const r of records) {
      const kind = classifyRow(r, f);
      counts[kind]++;
      if (kind === 'episode') episodes.push({ r, f, file: c.name });
      else if (kind === 'movie') movies.push({ r, f, file: c.name });
      else if (kind === 'follow') follows.push({ r, f, file: c.name });
      else unknown.push({ r, file: c.name });
    }
    analyzed.push({ name: c.name, rows: records.length, headers, fields: f, counts });
  }
  return { analyzed, episodes, movies, follows, unknown };
}

function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

export async function runImport(plan, log, setProgress) {
  const { episodes, movies, follows } = plan;
  const report = { matchedShows: 0, unmatchedShows: [], watchedImported: 0, epUnmatched: 0, moviesImported: 0, followsImported: 0 };

  // -- group episode + follow rows by show key (tvdb id, else name) --
  const byShow = new Map();
  const keyFor = (row, f) => {
    const id = f.seriesId ? num(row[f.seriesId]) : null;
    if (id) return `tvdb:${id}`;
    const t = f.title ? row[f.title] : '';
    return t ? `name:${t.toLowerCase()}` : null;
  };
  for (const e of episodes) {
    const k = keyFor(e.r, e.f);
    if (!k) { report.epUnmatched++; continue; }
    (byShow.get(k) || byShow.set(k, { epRows: [], followRows: [] }).get(k)).epRows.push(e);
  }
  for (const fo of follows) {
    const k = keyFor(fo.r, fo.f);
    if (!k) continue;
    (byShow.get(k) || byShow.set(k, { epRows: [], followRows: [] }).get(k)).followRows.push(fo);
  }

  const keys = [...byShow.keys()];
  log(`Found ${keys.length} shows, ${episodes.length} episode records, ${movies.length} movie records.`);
  log('Matching shows against TVmaze (rate-limited — a big library takes a few minutes)…');

  // checkpoint lets a re-run skip shows that already imported
  const done = new Set(await kv.get('import:doneKeys', []));

  let i = 0;
  for (const k of keys) {
    i++;
    setProgress(i / keys.length);
    if (done.has(k)) continue;
    const group = byShow.get(k);
    const sample = group.epRows[0] || group.followRows[0];
    const label = sample.f.title ? sample.r[sample.f.title] : k;

    let raw = null;
    try {
      if (k.startsWith('tvdb:')) raw = await tvmaze.byTvdb(k.slice(5));
      if (!raw && label) {
        const res = await tvmaze.search(label);
        raw = res.length ? res[0].show : null;
      }
    } catch (err) {
      log(`! ${label || k}: lookup failed (${err.message}) — will retry on next run`);
      continue;
    }
    if (!raw) {
      report.unmatchedShows.push(label || k);
      log(`? No TVmaze match for "${label || k}" (${group.epRows.length} episodes)`);
      done.add(k); await kv.set('import:doneKeys', [...done]);
      continue;
    }

    // upsert show
    const existing = await db.get('shows', raw.id);
    const watchDates = group.epRows.map(e => isoDate(e.r[e.f.watchedAt])).filter(Boolean).sort();
    const show = existing || {
      ...normalizeShow(raw),
      followedAt: watchDates[0] || new Date().toISOString(),
      archived: false, lastEpisodeSync: null,
    };
    await db.put('shows', show);

    // episode list from TVmaze, matched by season+number
    let epMap = new Map();
    try {
      const eps = await tvmaze.episodes(raw.id);
      const norm = eps.map(e => normalizeEpisode(e, raw.id));
      await db.putMany('episodes', norm);
      show.lastEpisodeSync = new Date().toISOString();
      await db.put('shows', show);
      for (const e of norm) epMap.set(`${e.season}:${e.number}`, e);
    } catch (err) {
      log(`! ${raw.name}: episode fetch failed (${err.message})`);
    }

    const toWatch = [];
    for (const { r, f } of group.epRows) {
      const s = f.season ? num(r[f.season]) : null;
      const n = f.epNumber ? num(r[f.epNumber]) : null;
      const ep = (s != null && n != null) ? epMap.get(`${s}:${n}`) : null;
      if (!ep) { report.epUnmatched++; continue; }
      toWatch.push({
        epId: ep.id, showId: raw.id,
        watchedAt: isoDate(f.watchedAt ? r[f.watchedAt] : null) || new Date().toISOString(),
        source: 'tvtime',
      });
    }
    if (toWatch.length) await db.putMany('watched', toWatch);
    report.watchedImported += toWatch.length;
    report.matchedShows++;
    if (group.followRows.length && !group.epRows.length) report.followsImported++;
    log(`✓ ${raw.name}: ${toWatch.length} episodes marked watched`);
    done.add(k); await kv.set('import:doneKeys', [...done]);
  }

  // -- movies --
  const seen = new Set((await db.all('movies')).map(m => m.imdbId || m.title));
  const movieRows = [];
  for (const { r, f } of movies) {
    const title = f.title ? r[f.title] : null;
    const imdb = f.imdbId ? r[f.imdbId] : null;
    if (!title && !imdb) continue;
    const dedupeKey = imdb || title;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    movieRows.push({
      id: uuid(), title: title || imdb, imdbId: imdb || null,
      watchedAt: isoDate(f.watchedAt ? r[f.watchedAt] : null),
      rating: f.rating ? num(r[f.rating]) : null, source: 'tvtime',
    });
  }
  if (movieRows.length) await db.putMany('movies', movieRows);
  report.moviesImported = movieRows.length;

  await kv.set('import:lastReport', { ...report, at: new Date().toISOString() });
  return report;
}

// ---------- UI ----------

const escI = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function startImportUI(files, container, { onDone, onBack }) {
  container.innerHTML = `<button class="back-btn" id="imp-back">&#8592; Cancel</button>
    <p class="muted">Reading files…</p>`;
  container.querySelector('#imp-back').onclick = onBack;

  let plan;
  try { plan = await analyzeFiles(files); }
  catch (err) {
    container.innerHTML = `<button class="back-btn" id="imp-back">&#8592; Back</button>
      <div class="panel"><h2>Could not read file</h2>
      <p>${escI(err.message)}</p>
      <p class="muted small">Tip: if the ZIP won't open, unzip it on your device and select the .csv files inside instead.</p></div>`;
    container.querySelector('#imp-back').onclick = onBack;
    return;
  }

  const totalEp = plan.episodes.length, totalMv = plan.movies.length,
        totalFo = plan.follows.length, totalUn = plan.unknown.length;

  container.innerHTML = `
    <button class="back-btn" id="imp-back">&#8592; Cancel</button>
    <div class="panel">
      <h2>Ready to import</h2>
      ${plan.analyzed.map(a => `
        <div class="simple-row"><span>${escI(a.name.split('/').pop())}</span>
        <span class="when">${a.rows} rows</span></div>`).join('')}
      <div class="stats-row" style="margin-top:12px">
        <div class="stat"><div class="num">${totalEp.toLocaleString()}</div><div class="lbl">episode records</div></div>
        <div class="stat"><div class="num">${totalMv}</div><div class="lbl">movie records</div></div>
        <div class="stat"><div class="num">${totalFo}</div><div class="lbl">followed shows</div></div>
        <div class="stat"><div class="num">${totalUn}</div><div class="lbl">unrecognized rows</div></div>
      </div>
      ${totalEp + totalMv + totalFo === 0 ? `
        <p style="margin-top:12px">Nothing recognizable found. The columns in your file may be different than expected — use "Copy column report" below and share it so the importer can be adapted.</p>
        <button class="big-btn" id="imp-cols" style="margin-top:10px">Copy column report</button>` : `
        <button class="big-btn accent" id="imp-go" style="margin-top:14px">Start import</button>
        <button class="big-btn" id="imp-cols">Copy column report</button>`}
    </div>
    <div class="progressbar hidden" id="imp-prog"><div style="width:0%"></div></div>
    <div class="import-log hidden" id="imp-log"></div>`;

  container.querySelector('#imp-back').onclick = onBack;
  const colReport = JSON.stringify(plan.analyzed.map(a =>
    ({ file: a.name, rows: a.rows, headers: a.headers, detected: a.fields, counts: a.counts })), null, 2);
  container.querySelector('#imp-cols').onclick = async () => {
    try { await navigator.clipboard.writeText(colReport); alert('Column report copied to clipboard'); }
    catch { prompt('Copy this:', colReport); }
  };

  const goBtn = container.querySelector('#imp-go');
  if (!goBtn) return;
  goBtn.onclick = async () => {
    goBtn.disabled = true;
    goBtn.textContent = 'Importing… keep this page open';
    const logEl = container.querySelector('#imp-log');
    const progEl = container.querySelector('#imp-prog');
    logEl.classList.remove('hidden');
    progEl.classList.remove('hidden');
    const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
    const setProgress = (p) => { progEl.firstElementChild.style.width = `${Math.round(p * 100)}%`; };

    try {
      const report = await runImport(plan, log, setProgress);
      await kv.del('import:doneKeys'); // finished cleanly — clear checkpoint
      log('');
      log(`Done! ${report.matchedShows} shows, ${report.watchedImported.toLocaleString()} watched episodes, ${report.moviesImported} movies.`);
      if (report.unmatchedShows.length)
        log(`Shows with no TVmaze match (${report.unmatchedShows.length}): ${report.unmatchedShows.join(', ')}`);
      if (report.epUnmatched)
        log(`${report.epUnmatched} episode records could not be matched to an episode.`);
      goBtn.textContent = 'Import finished — view library';
      goBtn.disabled = false;
      goBtn.onclick = onDone;
    } catch (err) {
      log(`\nImport stopped: ${err.message}`);
      log('Your progress is saved — run the import again with the same file and it will resume.');
      goBtn.textContent = 'Retry import';
      goBtn.disabled = false;
    }
  };
}
