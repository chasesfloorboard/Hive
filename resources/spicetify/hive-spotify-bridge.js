// Hive Spotify Bridge — installed by Hive's Linux installer.
// Spotify remains the streaming engine; this extension exposes only the
// minimum local control/state bridge Hive needs.
(function hiveSpotifyBridge() {
  const BRIDGE = 'http://127.0.0.1:43872';
  const BRIDGE_HEALTH_TIMEOUT_MS = 3000;
  const BRIDGE_TOKEN = '__HIVE_SPOTIFY_BRIDGE_TOKEN__';
  const BRIDGE_HEADERS = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BRIDGE_TOKEN}` };
  let lastCommandId = 0;
  let busy = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function spotifyUriValue(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
      for (const candidate of [value.uri, value.raw, value.value]) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
    }
    return '';
  }

  function spotifyImageUrl(value) {
    const source = String(value || '').trim();
    if (/^https?:\/\//i.test(source)) return source;
    if (/^spotify:image:/i.test(source)) {
      const id = source.slice('spotify:image:'.length).trim();
      if (/^[A-Za-z0-9_-]+$/.test(id)) return `https://i.scdn.co/image/${id}`;
    }
    return '';
  }

  let lastBridgeErrorAt = 0;
  let pollTimer = null;
  let stateTimer = null;
  let initTimer = null;
  let initialized = false;

  async function post(path, body) {
    // Every request has a deadline. When Hive quits mid-request the socket
    // can stay half-open forever; without a timeout that froze the command
    // loop and Hive lost control of Spotify until Spotify was restarted.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), path === '/playlist' ? 60000 : BRIDGE_HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${BRIDGE}${path}`, {
        method: 'POST',
        headers: BRIDGE_HEADERS,
        body: JSON.stringify(body || {}),
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (err) {
      const now = Date.now();
      if (now - lastBridgeErrorAt > 10000) {
        lastBridgeErrorAt = now;
        console.warn('[Hive Spotify Bridge] Hive loopback bridge unavailable:', err?.message || String(err));
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function playerPayload() {
    const data = Spicetify.Player?.data;
    const item = data?.item || data?.track;
    if (!data || !item) return { connected: true, player: null };
    // Sample the live Player API rather than relying on the last PlayerState
    // snapshot. Spotify exposes progress/duration/play state directly, and
    // these values are what Hive's scrubber and transport controls must mirror.
    const progressValue = typeof Spicetify.Player.getProgress === 'function'
      ? Spicetify.Player.getProgress()
      : data.position_as_of_timestamp;
    const durationValue = typeof Spicetify.Player.getDuration === 'function'
      ? Spicetify.Player.getDuration()
      : (data.duration || item.duration);
    const playingValue = typeof Spicetify.Player.isPlaying === 'function'
      ? Spicetify.Player.isPlaying()
      : !!data.is_playing && !data.is_paused;
    const artists = Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean) : [];
    const album = item.album || {};
    const metadata = item.metadata || {};
    const images = Array.isArray(album.images) ? album.images : [];
    // Spotify's current PlayerState exposes reliable artwork through the
    // internal track metadata fields. Keep album.images as the first choice,
    // but fall back through the documented Spicetify metadata URLs so a client
    // version that omits album.images cannot strand Hive without artwork.
    const artworkUrl = [
      images[0]?.url, images[1]?.url, images[2]?.url,
      metadata.image_xlarge_url, metadata.image_large_url,
      metadata.image_url, metadata.image_small_url
    ].map(spotifyImageUrl).find(Boolean) || '';
    const volumeValue = typeof Spicetify.Player.getVolume === 'function' ? Spicetify.Player.getVolume() : data.volume;
    const volume = Number.isFinite(Number(volumeValue)) ? Math.max(0, Math.min(1, Number(volumeValue))) : null;
    const repeatValue = typeof Spicetify.Player.getRepeat === 'function' ? Spicetify.Player.getRepeat() : null;
    const shuffleValue = typeof Spicetify.Player.getShuffle === 'function' ? Spicetify.Player.getShuffle() : null;
    return {
      connected: true,
      player: {
        uri: spotifyUriValue(item.uri),
        id: spotifyUriValue(item.uri).split(':').pop(),
        contextUri: spotifyUriValue(data.context_uri),
        title: String(item.name || ''),
        artist: artists.join(', '),
        album: String(album.name || ''),
        albumArtist: Array.isArray(album.artists) ? album.artists.map(a => a?.name).filter(Boolean).join(', ') : '',
        year: String(album.release_date || metadata.album_release_date || '').slice(0, 4),
        duration: Number(durationValue || 0) / 1000,
        position: Number(progressValue || 0) / 1000,
        isPlaying: !!playingValue,
        isPaused: !playingValue,
        // getProgress() is sampled now, so anchor Hive's interpolation clock
        // to this exact sample instead of an older PlayerState timestamp.
        timestamp: Date.now(),
        cover: artworkUrl,
        artworkUrl,
        volume,
        shuffle: typeof shuffleValue === 'boolean' ? shuffleValue : null,
        repeat: Number.isInteger(Number(repeatValue)) ? Number(repeatValue) : null
      }
    };
  }

  async function sendState() { await post('/state', playerPayload()); }

  // Spotify's own playlist API (Spicetify.Platform.PlaylistAPI) reads the
  // playlist the way the client does: private, collaborative and very long
  // playlists all work, with no Web API rate limits. Older clients fall back
  // to the Web API through CosmosAsync.
  function platformTrack(item, id) {
    const uri = spotifyUriValue(item?.uri);
    if (!/^spotify:track:/.test(uri) || !item?.name) return null;
    const album = item.album || {};
    const images = Array.isArray(album.images) ? album.images : [];
    const artworkUrl = images.map(x => spotifyImageUrl(x?.url)).find(Boolean) || '';
    const artists = Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean).join(', ') : '';
    const ms = Number(item.duration?.milliseconds ?? item.duration ?? 0) || 0;
    return {
      title: String(item.name), artist: artists, album: String(album.name || ''), albumUri: spotifyUriValue(album.uri),
      albumArtist: String(album.artist?.name || (Array.isArray(album.artists) ? album.artists.map(a => a?.name).filter(Boolean).join(', ') : '') || ''),
      year: '', duration: ms / 1000, spotifyUri: uri, spotifyId: uri.split(':').pop(),
      contextUri: `spotify:playlist:${id}`, spotifyContextUri: `spotify:playlist:${id}`, cover: artworkUrl, artworkUrl
    };
  }

  async function readPlaylistWithPlatform(id) {
    const api = Spicetify?.Platform?.PlaylistAPI;
    if (!api?.getContents) return null;
    const uri = `spotify:playlist:${id}`;
    let meta = null;
    try { meta = await api.getMetadata(uri); } catch {}
    const tracks = [];
    const limit = 500;
    for (let offset = 0; offset < 20000; offset += limit) {
      const page = await api.getContents(uri, { offset, limit });
      const items = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) { const t = platformTrack(item, id); if (t) tracks.push(t); }
      const total = Number(page?.totalLength ?? page?.totalCount ?? 0);
      if (items.length < limit || (total && offset + limit >= total)) break;
    }
    const images = Array.isArray(meta?.images) ? meta.images.map(x => x?.url) : [];
    return { name: String(meta?.name || ''), description: String(meta?.description || ''), images, tracks };
  }

  async function readPlaylistWithWebApi(id) {
    const fields = 'name,description,external_urls,images,tracks.items(track(name,uri,duration_ms,artists(name),album(uri,name,images,artists(name),release_date))),tracks.next,tracks.total';
    let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`;
    const tracks = [];
    let first = null;
    while (url) {
      const data = await Spicetify.CosmosAsync.get(url);
      if (!first) first = data;
      for (const item of data?.tracks?.items || []) {
        const t = item?.track;
        if (!t?.uri || !t?.name) continue;
        const images = Array.isArray(t.album?.images) ? t.album.images : [];
        const metadata = t.metadata || {};
        const artworkUrl = [
          images[0]?.url, images[1]?.url, images[2]?.url,
          metadata.image_xlarge_url, metadata.image_large_url,
          metadata.image_url, metadata.image_small_url
        ].map(spotifyImageUrl).find(Boolean) || '';
        tracks.push({
          title: String(t.name),
          artist: Array.isArray(t.artists) ? t.artists.map(a => a?.name).filter(Boolean).join(', ') : '',
          album: String(t.album?.name || ''),
          albumUri: String(t.album?.uri || ''),
          albumArtist: Array.isArray(t.album?.artists) ? t.album.artists.map(a => a?.name).filter(Boolean).join(', ') : '',
          year: String(t.album?.release_date || '').slice(0, 4),
          duration: Number(t.duration_ms || 0) / 1000,
          spotifyUri: String(t.uri),
          spotifyId: String(t.uri).split(':').pop(),
          contextUri: `spotify:playlist:${id}`,
          spotifyContextUri: `spotify:playlist:${id}`,
          cover: artworkUrl,
          artworkUrl
        });
      }
      url = data?.tracks?.next || '';
    }
    return { name: String(first?.name || ''), description: String(first?.description || ''), images: Array.isArray(first?.images) ? first.images.map(x => x?.url) : [], tracks };
  }

  async function importPlaylist(command) {
    const id = String(command.playlistId || '').trim();
    if (!id) throw new Error('Missing Spotify playlist id');
    let result = null, platformError = null;
    try { result = await readPlaylistWithPlatform(id); } catch (err) { platformError = err; }
    if (!result || (!result.tracks.length && Spicetify?.CosmosAsync)) {
      try { result = await readPlaylistWithWebApi(id); }
      catch (err) {
        await post('/playlist', { commandId: Number(command.id), id, error: String((platformError || err)?.message || platformError || err) });
        return;
      }
    }
    const playlistArtwork = [...result.images, ...result.tracks.slice(0, 8).map(x => x.artworkUrl)].map(spotifyImageUrl).find(Boolean) || '';
    await post('/playlist', {
      commandId: Number(command.id),
      id,
      name: String(result.name || 'Spotify Playlist'),
      description: String(result.description || ''),
      sourceUrl: `https://open.spotify.com/playlist/${id}`,
      cover: playlistArtwork,
      artworkUrl: playlistArtwork,
      tracks: result.tracks,
      contextUri: `spotify:playlist:${id}`,
      source: 'spotify'
    });
  }

  // The playlists in the user's Spotify library (folders flattened), for
  // Hive's Spotify page.
  async function sendLibraryPlaylists(command) {
    const out = [];
    try {
      const api = Spicetify?.Platform?.RootlistAPI;
      const res = api?.getContents ? await api.getContents({ limit: 2000 }) : null;
      const walk = list => {
        for (const it of list || []) {
          if (it?.type === 'folder') walk(it.items);
          else if (it?.type === 'playlist' && it.uri) {
            const images = Array.isArray(it.images) ? it.images : [];
            out.push({ uri: spotifyUriValue(it.uri), name: String(it.name || ''), owner: String(it.owner?.name || it.owner?.displayName || ''),
              count: Number(it.totalLength ?? it.length ?? 0) || 0, image: images.map(x => spotifyImageUrl(x?.url)).find(Boolean) || '' });
          }
        }
      };
      walk(res?.items);
      await post('/result', { commandId: Number(command.id), data: { playlists: out } });
    } catch (err) {
      await post('/result', { commandId: Number(command.id), error: String(err?.message || err) });
    }
  }

  // Spotify's Home feed (the signed-in user's shelves) through Spotify's
  // own GraphQL "home" query, flattened to { title, items[{ uri, name,
  // subtitle, image, kind }] } for Hive's Spotify page.
  function firstImage(value, depth = 0) {
    if (!value || depth > 7) return '';
    if (typeof value === 'string') return /^https:\/\/(i\.scdn\.co|image-cdn-[a-z]+\.spotifycdn\.com|mosaic\.scdn\.co)\//.test(value) ? value : '';
    if (Array.isArray(value)) { for (const v of value) { const f = firstImage(v, depth + 1); if (f) return f; } return ''; }
    if (typeof value === 'object') {
      if (typeof value.url === 'string' && firstImage(value.url)) return value.url;
      for (const k of Object.keys(value)) { const f = firstImage(value[k], depth + 1); if (f) return f; }
    }
    return '';
  }
  async function sendHome(command) {
    try {
      const GQL = Spicetify?.GraphQL;
      const def = GQL?.Definitions?.home;
      if (!GQL?.Request || !def) throw new Error('This Spotify version does not expose its Home feed.');
      const res = await GQL.Request(def, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', sp_t: '', facet: '', sectionItemsLimit: 12 });
      const sections = res?.data?.home?.sectionContainer?.sections?.items || [];
      const shelves = [];
      for (const section of sections) {
        const title = String(section?.data?.title?.transformedLabel || section?.data?.title?.text || '').trim();
        const items = [];
        for (const it of section?.sectionItems?.items || []) {
          const data = it?.content?.data || {};
          const uri = String(data.uri || it?.uri || '');
          const kind = (uri.split(':')[1] || '').toLowerCase();
          if (!/^(playlist|album|artist|show|episode)$/.test(kind)) continue;
          const name = String(data.name || data.profile?.name || '').trim();
          if (!name) continue;
          const subtitle = String(data.ownerV2?.data?.name || data.artists?.items?.map(a => a?.profile?.name).filter(Boolean).join(', ') || data.publisher?.name || data.description || '').replace(/<[^>]+>/g, '').trim();
          items.push({ uri, name, subtitle: subtitle.slice(0, 120), image: firstImage(data.images || data.coverArt || data.visuals || data), kind });
        }
        if (title && items.length) shelves.push({ title, items });
      }
      await post('/result', { commandId: Number(command.id), data: { shelves } });
    } catch (err) {
      await post('/result', { commandId: Number(command.id), error: String(err?.message || err) });
    }
  }

  // Spotify's own search: songs, artists, albums and playlists for a term.
  // The app always carries its quick-search query (its full search page loads
  // its own only when opened), which answers with plenty when asked for 40.
  // Spotify's Web API refuses the app's sign-in (429), so it isn't used.
  async function sendSearch(command) {
    try {
      const GQL = Spicetify?.GraphQL;
      // The search query's name has changed between Spotify versions.
      const defs = GQL?.Definitions || {};
      const name = ['searchDesktop', 'searchModalResults', 'searchTopResultsList', 'searchFullResults'].find(n => defs[n]) || Object.keys(defs).find(n => /^search/i.test(n) && !/suggest|autocomplete/i.test(n));
      const def = name ? defs[name] : null;
      if (!GQL?.Request || !def) throw new Error(`This Spotify version does not expose search (it has: ${Object.keys(defs).filter(n => /search/i.test(n)).join(', ') || 'no search queries'}).`);
      const res = await GQL.Request(def, {
        searchTerm: String(command.query || '').slice(0, 200), offset: 0, limit: 30, numberOfTopResults: 40,
        includeAudiobooks: false, includeArtistHasConcertsField: false, includePreReleases: true, includeLocalConcertsField: false, includeAuthors: false,
      });
      const s = res?.data?.searchV2 || {};
      const names = list => (list?.items || []).map(a => a?.profile?.name).filter(Boolean).join(', ');
      // Results come as separate lists (tracksV2, albumsV2, …) or as one mixed
      // "top results" list, depending on the query; every list is read and
      // each item filed by its kind.
      const entries = [];
      for (const value of Object.values(s)) {
        if (!value || typeof value !== 'object') continue;
        for (const list of [value.items, value.itemsV2]) if (Array.isArray(list)) entries.push(...list);
      }
      const tracks = [], albums = [], artists = [], playlists = [], seen = new Set();
      for (const entry of entries) {
        const d = entry?.item?.data || entry?.data || entry?.item || entry;
        const uri = String(d?.uri || '');
        if (!uri || seen.has(uri)) continue;
        seen.add(uri);
        const kind = uri.split(':')[1];
        if (kind === 'track') tracks.push({ uri, title: String(d.name || ''), artist: names(d.artists), album: String(d.albumOfTrack?.name || ''), duration: Number(d.duration?.totalMilliseconds || 0), image: firstImage(d.albumOfTrack?.coverArt) });
        else if (kind === 'album') albums.push({ uri, name: String(d.name || ''), subtitle: names(d.artists), image: firstImage(d.coverArt) });
        else if (kind === 'artist') artists.push({ uri, name: String(d.profile?.name || ''), image: firstImage(d.visuals?.avatarImage) });
        else if (kind === 'playlist') playlists.push({ uri, name: String(d.name || ''), subtitle: String(d.ownerV2?.data?.name || ''), image: firstImage(d.images) });
      }
      await post('/result', { commandId: Number(command.id), data: { tracks, albums, artists, playlists, query: name } });
    } catch (err) {
      await post('/result', { commandId: Number(command.id), error: String(err?.message || err) });
    }
  }

  async function execute(command) {
    const type = command?.command?.type;
    if (type === 'search') return sendSearch({ ...command.command, id: command.id });
    if (type === 'getHome') return sendHome({ ...command.command, id: command.id });
    if (type === 'getPlaylist') return importPlaylist(command.command);
    if (type === 'getLibraryPlaylists') return sendLibraryPlaylists(command.command.id ? command.command : { ...command.command, id: command.id });
    if (type === 'playUri') {
      const uri = spotifyUriValue(command.command.uri);
      if (!uri) throw new Error('Missing Spotify track URI');
      const contextUri = spotifyUriValue(command.command.contextUri || command.command.spotifyContextUri);
      // Spicetify's current Player wrapper uses ContextOption.contextURI for
      // playlist/album context. Passing { uri: ... } looks plausible but is
      // not the current context shape and can cause playUri() to reject or
      // lose the provider context on newer Spotify clients.
      const context = contextUri ? { contextURI: contextUri, trackUri: uri } : undefined;
      try {
        return await Spicetify.Player.playUri(uri, context);
      } catch (contextError) {
        // Context playback is an enhancement, not permission to make a single
        // Spotify track unplayable on a client whose internal context shape has
        // changed. Retry the documented bare-track form so audio still starts;
        // subsequent provider state remains authoritative for the actual track.
        if (!contextUri) throw contextError;
        console.warn('[Hive Spotify Bridge] contextual playUri failed; retrying bare track:', contextError?.message || String(contextError));
        return Spicetify.Player.playUri(uri);
      }
    }
    if (type === 'play') return Spicetify.Player.play();
    if (type === 'pause') return Spicetify.Player.pause();
    if (type === 'next') return Spicetify.Player.next();
    if (type === 'previous') return Spicetify.Player.back();
    if (type === 'seek') return Spicetify.Player.seek(Number(command.command.positionMs) || 0);
    if (type === 'shuffle') return Spicetify.Player.setShuffle(!!command.command.enabled);
    if (type === 'repeat') return Spicetify.Player.setRepeat(Math.max(0, Math.min(2, Number(command.command.mode) || 0)));
    if (type === 'volume') return Spicetify.Player.setVolume(Math.max(0, Math.min(1, Number(command.command.value) || 0)));
    if (type === 'mute') return Spicetify.Player.setMute(!!command.command.value);
    return null;
  }

  let busySince = 0;
  async function poll() {
    // Watchdog: a command that never settles (e.g. a Spotify API promise)
    // must not stop the loop for good.
    if (busy && Date.now() - busySince < 90000) return;
    busy = true; busySince = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
      let response;
      try { response = await fetch(`${BRIDGE}/commands?after=${lastCommandId}`, { headers: { 'Authorization': `Bearer ${BRIDGE_TOKEN}` }, cache: 'no-store', signal: controller.signal }); }
      finally { clearTimeout(timer); }
      const data = await response.json();
      for (const command of data?.commands || []) {
        lastCommandId = Math.max(lastCommandId, Number(command.id) || 0);
        try { await execute(command); } catch (err) { console.error('[Hive Spotify Bridge]', err); }
        await post('/ack', { id: command.id });
        await sendState();
      }
    } catch (err) {
      const now = Date.now();
      if (now - lastBridgeErrorAt > 10000) {
        lastBridgeErrorAt = now;
        console.warn('[Hive Spotify Bridge] command poll unavailable:', err?.message || String(err));
      }
    }
    busy = false;
  }

  function scheduleInitRetry() {
    if (initTimer) return;
    initTimer = setTimeout(() => {
      initTimer = null;
      init();
    }, 300);
  }

  // Spotify runs hidden for Hive. Chromium throttles a hidden, silent
  // page's timers to about once a minute, so after a pause Hive's commands
  // would wait up to a minute. A dedicated worker's timer isn't throttled
  // that way; fall back to a page timer if workers are unavailable.
  function unthrottledInterval(fn, ms) {
    try {
      const src = `setInterval(() => postMessage(0), ${Number(ms) || 1000});`;
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = () => fn();
      return worker;
    } catch {
      return setInterval(fn, ms);
    }
  }

  function startPolling() {
    if (pollTimer) return;
    // Run once immediately so a command does not have to wait for the first
    // interval tick after Spotify finishes exposing its APIs.
    poll();
    pollTimer = unthrottledInterval(poll, 250);
  }

  function startStateUpdates() {
    if (stateTimer) return;
    sendState();
    stateTimer = unthrottledInterval(sendState, 1000);
  }

  function registerPlayerEvents() {
    const player = globalThis.Spicetify?.Player;
    if (!player || typeof player.addEventListener !== 'function') {
      console.warn('[Hive] Spotify bridge: Player event API is not ready.');
      return false;
    }
    const handlers = {
      songchange: () => { void sendState(); },
      onplaypause: () => { void sendState(); },
      onprogress: () => { void sendState(); }
    };
    for (const event of Object.keys(handlers)) {
      try {
        player.addEventListener(event, handlers[event]);
      } catch (err) {
        // Event registration is supplementary. A single incompatible event
        // must never prevent command polling from controlling Spotify.
        console.warn(`[Hive] Spotify bridge: could not register ${event}:`, err?.message || String(err));
      }
    }
    return true;
  }

  function init() {
    const api = globalThis.Spicetify;
    const player = api?.Player;
    const cosmos = api?.CosmosAsync;

    if (!player || !cosmos || typeof player.playUri !== 'function') {
      scheduleInitRetry();
      return;
    }

    // Start the control path before registering optional state events. This
    // prevents one event/API incompatibility from stranding Hive commands.
    startPolling();
    startStateUpdates();
    registerPlayerEvents();

    if (!initialized) {
      initialized = true;
      console.info('[Hive] Spotify bridge ready');
    }
  }

  init();
})();
