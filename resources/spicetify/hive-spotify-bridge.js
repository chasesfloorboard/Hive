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
    try {
      const response = await fetch(`${BRIDGE}${path}`, {
        method: 'POST',
        headers: BRIDGE_HEADERS,
        body: JSON.stringify(body || {})
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

  async function importPlaylist(command) {
    const id = String(command.playlistId || '').trim();
    if (!id) throw new Error('Missing Spotify playlist id');
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
    const playlistArtwork = [
      ...(Array.isArray(first?.images) ? first.images.map(x => x?.url) : []),
      ...(tracks.slice(0, 8).map(x => x.artworkUrl))
    ].map(spotifyImageUrl).find(Boolean) || '';
    await post('/playlist', {
      commandId: Number(command.id),
      id,
      name: String(first?.name || 'Spotify Playlist'),
      description: String(first?.description || ''),
      sourceUrl: `https://open.spotify.com/playlist/${id}`,
      cover: playlistArtwork,
      artworkUrl: playlistArtwork,
      tracks,
      contextUri: `spotify:playlist:${id}`,
      source: 'spotify'
    });
  }

  async function execute(command) {
    const type = command?.command?.type;
    if (type === 'getPlaylist') return importPlaylist(command.command);
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

  async function poll() {
    if (busy) return;
    busy = true;
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

  function startPolling() {
    if (pollTimer) return;
    // Run once immediately so a command does not have to wait for the first
    // interval tick after Spotify finishes exposing its APIs.
    poll();
    pollTimer = setInterval(poll, 250);
  }

  function startStateUpdates() {
    if (stateTimer) return;
    sendState();
    stateTimer = setInterval(sendState, 1000);
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
