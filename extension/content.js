// ShowTrack scrobbler content script. Watches the page's <video>; when you're
// ~92% through, it reads what's playing and tells the background to scrobble it.
// Per-site parsers extract {title, season, episode, epName}; anything unknown
// falls back to parsing document.title.

(() => {
  'use strict';
  const host = location.hostname;
  let lastKey = null;      // dedupe: one scrobble per episode view
  let sent = false;

  // ---- per-site parsers ----
  function parseNetflix() {
    // Netflix player overlay: <div data-uia="video-title"><h4>Show</h4><span>S1:E3</span><span>Ep name</span></div>
    const box = document.querySelector('[data-uia="video-title"]');
    if (box) {
      const title = box.querySelector('h4')?.textContent?.trim();
      const spans = [...box.querySelectorAll('span')].map(s => s.textContent.trim());
      const sm = spans.map(s => s.match(/S(\d+):E(\d+)/i)).find(Boolean);
      if (title && sm) return { title, season: +sm[1], episode: +sm[2], epName: spans[spans.length - 1] };
      if (title) return { title }; // movie
    }
    return null;
  }
  function parseCrunchyroll() {
    // Crunchyroll: title like "Show Name Episode 12 – Episode Title"
    const t = document.querySelector('h1, .erc-current-media-info h4, [class*="title"]')?.textContent?.trim()
      || document.title;
    const m = t.match(/^(.*?)\s+Episode\s+(\d+)\s*[–-]\s*(.*)$/i);
    if (m) return { title: m[1].trim(), season: 1, episode: +m[2], epName: m[3].trim() };
    return { title: (t || '').replace(/\s*[-–|].*$/, '').trim() };
  }
  function parseGeneric() {
    // Last-resort: "Show: Season 1: Episode Name" or "Show - Episode" from title
    const t = document.title.replace(/\s*[|\-–]\s*(Hulu|Disney\+|Max|Prime Video|Watch).*/i, '').trim();
    const parts = t.split(/:\s*/);
    const sm = t.match(/season\s+(\d+)/i);
    if (parts.length >= 2 || sm) return { title: parts[0], season: sm ? +sm[1] : null, epName: parts[parts.length - 1] };
    return { title: t };
  }

  const platformFor = (h) =>
    /netflix/.test(h) ? 'Netflix' : /crunchyroll/.test(h) ? 'Crunchyroll' :
    /hulu/.test(h) ? 'Hulu' : /disneyplus/.test(h) ? 'Disney+' : /max\./.test(h) ? 'Max' :
    /primevideo|amazon/.test(h) ? 'Prime Video' : '';

  function parse() {
    let info = null;
    if (/netflix/.test(host)) info = parseNetflix();
    else if (/crunchyroll/.test(host)) info = parseCrunchyroll();
    // fall back to the title parser if the site-specific one found nothing
    return (info && info.title) ? info : parseGeneric();
  }

  function tick() {
    const video = document.querySelector('video');
    if (!video || !video.duration || isNaN(video.duration)) return;
    const info = parse();
    if (!info || !info.title) return;

    const key = `${info.title}|${info.season ?? ''}|${info.episode ?? info.epName ?? ''}`;
    if (key !== lastKey) { lastKey = key; sent = false; }  // new episode → arm again

    const progress = video.currentTime / video.duration;
    if (!sent && progress >= 0.92) {
      sent = true;
      chrome.runtime.sendMessage({
        type: 'scrobble',
        data: { platform: platformFor(host), title: info.title, season: info.season ?? null, episode: info.episode ?? null, epName: info.epName || null },
      });
    }
  }

  setInterval(tick, 5000);
})();
