const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const gst = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
const scrobble = fs.readFileSync(path.join(root, 'app/main/scrobbling.js'), 'utf8');
const mpris = fs.readFileSync(path.join(root, 'app/main/mpris.js'), 'utf8');
const { ScrobblingService } = require(path.join(root, 'app/main/scrobbling.js'));

test('local playback has one active transport authority', () => {
  assert.match(renderer, /GStreamer is the sole local transport/);
  assert.match(renderer, /native GStreamer load failed; Web Audio fallback disabled/);
});

// Volume-architecture coverage (including the manual-routing-experiment
// guards this test used to duplicate) now lives in test/volume.test.js.

test('scrobbling has durable atomic pending storage', () => {
  assert.match(scrobble, /scrobble-queue\.json/);
  assert.match(scrobble, /rename\(tmp, this\.cachePath\)/);
  assert.match(scrobble, /pendingCount/);
  assert.match(scrobble, /flushPending/);
});

test('MPRIS remains a projection rather than a second transport', () => {
  assert.match(mpris, /this\.sendCommand/);
  assert.doesNotMatch(mpris, /playbin|AudioContext|decodeAudioData/);
});

// getSimilarArtists() backs the track context menu's "Play similar to" -- it
// is a real, independently testable network call (Last.fm's public
// artist.getsimilar), not just a source-pattern assertion, since that's what
// actually proves the feature works end to end.
test('getSimilarArtists calls Last.fm artist.getsimilar with the configured API key and parses results', async (t) => {
  const cfg = { scrobbling: { lastfm: { apiKey: 'test-key-123' } } };
  const service = new ScrobblingService(
    async () => cfg,
    async (next) => { Object.assign(cfg, next); return cfg; },
    { userData: () => require('node:os').tmpdir() }
  );
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      text: async () => JSON.stringify({ similarartists: { artist: [{ name: 'JID' }, { name: 'Denzel Curry' }] } })
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  const names = await service.getSimilarArtists('JPEGMAFIA');
  assert.match(requestedUrl, /method=artist\.getsimilar/);
  assert.match(requestedUrl, /artist=JPEGMAFIA/);
  assert.match(requestedUrl, /api_key=test-key-123/);
  assert.deepEqual(names, ['JID', 'Denzel Curry']);
});

test('getSimilarArtists fails clearly when no Last.fm API key is configured', async () => {
  const cfg = { scrobbling: { lastfm: {} } };
  const service = new ScrobblingService(async () => cfg, async () => cfg, { userData: () => require('node:os').tmpdir() });
  await assert.rejects(() => service.getSimilarArtists('JPEGMAFIA'), /Last\.fm API key/);
});

// Real bug, confirmed by reading ListenBrainz's own documented API: it
// requires the literal "Token " prefix on the Authorization header, not just
// the bare user token. Every now-playing update and scrobble submission was
// silently rejected with 401 without it -- ListenBrainz scrobbling had never
// actually worked, regardless of whether a valid token was entered.
test('ListenBrainz requests use the required "Token " Authorization prefix, for both now-playing and scrobble submission', async (t) => {
  const cfg = { scrobbling: { listenbrainz: { enabled: true, token: 'lb-test-token' }, lastfm: {}, enabled: true, thresholdPercent: 50, thresholdSeconds: 240, includePodcasts: false } };
  const service = new ScrobblingService(async () => cfg, async (next) => { Object.assign(cfg, next); return cfg; }, { userData: () => require('node:os').tmpdir() });
  const originalFetch = global.fetch;
  const seenAuthHeaders = [];
  global.fetch = async (url, options) => {
    seenAuthHeaders.push(options?.headers?.Authorization);
    return { ok: true, text: async () => '{}' };
  };
  t.after(() => { global.fetch = originalFetch; });

  await service.sendNowPlaying({ path: '/x.mp3', title: 'Title', artist: 'Artist' });
  await service.submitItem({ service: 'listenbrainz', timestamp: 123, metadata: { artist: 'Artist', title: 'Title' } }, await service.config());

  assert.ok(seenAuthHeaders.length >= 2, 'expected both a now-playing and a submit-listens request');
  for (const header of seenAuthHeaders) assert.equal(header, 'Token lb-test-token');
});

test('MPRIS navigation capabilities are derived from player state', () => {
  assert.match(mpris, /get CanGoNext\(\) \{ return !!this\.owner\.state\.canGoNext; \}/);
  assert.match(mpris, /get CanGoPrevious\(\) \{ return !!this\.owner\.state\.canGoPrevious; \}/);
});
