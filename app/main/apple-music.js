'use strict';
// Hive 2.0 Apple Music browser. Reads Apple Music's public web pages (the
// same data music.apple.com shows signed-out visitors) for search results,
// playlists and albums, and adds 30-second previews from Apple's public
// iTunes lookup API. No Apple ID or developer token is used, so full songs
// can't be streamed: Hive plays matching songs from the user's own library
// and previews for the rest.

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function serverData(html) {
  const m = String(html || '').match(/<script[^>]+id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function sectionsOf(data) {
  const page = Array.isArray(data?.data) ? data.data[0] : data?.data;
  return Array.isArray(page?.data?.sections) ? page.data.sections : [];
}

// Apple artwork URLs are templates: .../{w}x{h}bb.{f}
function artworkUrl(artwork, size = 600) {
  const url = String(artwork?.dictionary?.url || artwork?.url || '');
  if (!/^https:\/\//i.test(url)) return '';
  return url.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg').replace('{c}', 'bb');
}

const linkTitles = links => (Array.isArray(links) ? links.map(l => String(l?.title || '').trim()).filter(Boolean) : []);

function lockupToCollection(item) {
  const cd = item?.contentDescriptor || {};
  const id = String(cd.identifiers?.storeAdamID || '');
  if (!id || !/^(playlist|album)$/.test(String(cd.kind))) return null;
  return {
    kind: String(cd.kind), id,
    name: linkTitles(item.titleLinks)[0] || String(item.title || ''),
    curator: linkTitles(item.subtitleLinks).join(', '),
    artwork: artworkUrl(item.artwork, 400),
    url: String(cd.url || '')
  };
}

function parseSearch(html) {
  const out = { playlists: [], albums: [] };
  for (const section of sectionsOf(serverData(html))) {
    for (const item of section.items || []) {
      const c = lockupToCollection(item);
      if (!c) continue;
      const list = c.kind === 'playlist' ? out.playlists : out.albums;
      const seen = list.find(p => p.id === c.id);
      if (!seen) list.push(c);
      else if (!seen.curator && c.curator) seen.curator = c.curator;
    }
  }
  return out;
}

function parseCollection(html) {
  const sections = sectionsOf(serverData(html));
  const header = sections.find(s => /detail-header/.test(String(s.id)))?.items?.[0] || null;
  const tracks = [];
  for (const section of sections.filter(s => s.itemKind === 'trackLockup')) {
    for (const item of section.items || []) {
      const cd = item?.contentDescriptor || {};
      const id = String(cd.identifiers?.storeAdamID || '');
      if (!id || !item.title) continue;
      tracks.push({
        appleId: id,
        title: String(item.title),
        artist: linkTitles(item.subtitleLinks).join(', '),
        album: linkTitles(item.tertiaryLinks)[0] || '',
        duration: (Number(item.duration) || 0) / 1000,
        artwork: artworkUrl(item.artwork, 600),
        url: String(cd.url || ''),
        previewUrl: ''
      });
    }
  }
  const more = [];
  for (const section of sections.filter(s => s.itemKind === 'squareLockup')) {
    for (const item of section.items || []) { const c = lockupToCollection(item); if (c && !more.some(x => x.id === c.id)) more.push(c); }
  }
  if (!header && !tracks.length) return null;
  return {
    name: String(header?.title || ''),
    curator: linkTitles(header?.subtitleLinks).join(', '),
    description: String(header?.description?.standard || header?.description?.short || header?.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    artwork: artworkUrl(header?.artwork, 1000),
    tracks,
    more: more.slice(0, 16)
  };
}

// The Browse page: shelves of playlists/albums ("New This Week", "Daily
// Top 100", ...) and of songs ("Best New Songs"). Radio, videos and the
// like are left out.
function trackFromLockup(item) {
  const cd = item?.contentDescriptor || {};
  const id = String(cd.identifiers?.storeAdamID || '');
  if (!id || cd.kind !== 'song' || !item.title) return null;
  return {
    appleId: id, title: String(item.title), artist: linkTitles(item.subtitleLinks).join(', '),
    album: linkTitles(item.tertiaryLinks)[0] || '', duration: (Number(item.duration) || 0) / 1000,
    artwork: artworkUrl(item.artwork, 600), url: String(cd.url || ''), previewUrl: ''
  };
}
function parseBrowse(html) {
  const shelves = [];
  for (const section of sectionsOf(serverData(html))) {
    const title = section.header?.item?.titleLink?.title || (section.itemKind === 'flowcaseLockup' ? 'Featured' : '');
    if (section.itemKind === 'trackLockup') {
      const songs = (section.items || []).map(trackFromLockup).filter(Boolean);
      if (songs.length) shelves.push({ title, kind: 'songs', items: songs.slice(0, 20) });
      continue;
    }
    const cards = [];
    for (const item of section.items || []) {
      const c = lockupToCollection(item) || (() => {
        const cd = item?.contentDescriptor || {};
        const id = String(cd.identifiers?.storeAdamID || '');
        if (!id || !/^(playlist|album)$/.test(String(cd.kind))) return null;
        return { kind: String(cd.kind), id, name: String(item.title || item.headline || ''), curator: String(item.subtitle || ''), artwork: artworkUrl(item.artwork, 400), url: String(cd.url || '') };
      })();
      if (c && c.name && !cards.some(x => x.id === c.id)) cards.push(c);
    }
    if (cards.length) shelves.push({ title, kind: 'cards', items: cards.slice(0, 20) });
  }
  return shelves;
}

// https://music.apple.com/<storefront>/<playlist|album>/<slug>/<id>
function parseAppleMusicUrl(input) {
  const m = String(input || '').trim().match(/^https:\/\/(?:embed\.)?music\.apple\.com\/([a-z]{2})\/(playlist|album)\/(?:[^/?#]+\/)?((?:pl\.[A-Za-z0-9.-]+)|\d+)/i);
  return m ? { storefront: m[1].toLowerCase(), kind: m[2].toLowerCase(), id: m[3] } : null;
}

function create({ net }) {
  async function getText(url) {
    const res = await net.fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!res.ok) throw new Error(`Apple Music answered ${res.status}`);
    return res.text();
  }

  async function search(term, storefront = 'us') {
    const q = String(term || '').trim().slice(0, 100);
    if (!q) return { playlists: [], albums: [] };
    const sf = /^[a-z]{2}$/i.test(storefront) ? storefront.toLowerCase() : 'us';
    return parseSearch(await getText(`https://music.apple.com/${sf}/search?term=${encodeURIComponent(q)}`));
  }

  // Fill previewUrl from the public iTunes lookup API (up to 150 ids a call).
  async function addPreviews(tracks, storefront) {
    for (let i = 0; i < tracks.length; i += 150) {
      const batch = tracks.slice(i, i + 150);
      try {
        const res = await net.fetch(`https://itunes.apple.com/lookup?id=${batch.map(t => t.appleId).join(',')}&country=${storefront}`, { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) continue;
        const data = await res.json();
        const byId = new Map((data?.results || []).filter(r => r?.trackId).map(r => [String(r.trackId), r]));
        for (const t of batch) {
          const r = byId.get(t.appleId);
          if (!r) continue;
          if (/^https:\/\//i.test(String(r.previewUrl || ''))) t.previewUrl = String(r.previewUrl);
          if (!t.album && r.collectionName) t.album = String(r.collectionName);
          if (r.releaseDate) t.year = String(r.releaseDate).slice(0, 4);
          if (r.primaryGenreName) t.genre = String(r.primaryGenreName);
        }
      } catch { /* previews are optional */ }
    }
    return tracks;
  }

  async function getCollection(input) {
    const ref = parseAppleMusicUrl(input);
    if (!ref) throw new Error('Enter a music.apple.com playlist or album link.');
    const page = parseCollection(await getText(`https://music.apple.com/${ref.storefront}/${ref.kind}/x/${ref.id}`));
    if (!page) throw new Error('Apple Music did not share this playlist publicly.');
    await addPreviews(page.tracks, ref.storefront);
    return { ...page, ...ref, url: `https://music.apple.com/${ref.storefront}/${ref.kind}/${ref.id}` };
  }

  let browseCache = null;
  async function browse(storefront = 'us') {
    const sf = /^[a-z]{2}$/i.test(storefront) ? storefront.toLowerCase() : 'us';
    if (browseCache && browseCache.sf === sf && Date.now() - browseCache.at < 30 * 60 * 1000) return browseCache.shelves;
    const shelves = parseBrowse(await getText(`https://music.apple.com/${sf}/browse`));
    browseCache = { sf, at: Date.now(), shelves };
    return shelves;
  }

  return { search, getCollection, browse };
}

module.exports = { create, parseSearch, parseCollection, parseBrowse, parseAppleMusicUrl, artworkUrl };
