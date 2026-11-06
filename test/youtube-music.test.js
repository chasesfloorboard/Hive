const test = require('node:test');
const assert = require('node:assert/strict');
const { create, normalise, similarity, containment, scoreCandidate, acceptable, urlExpiry } = require('../app/main/youtube-music');

test('titles are compared without featuring credits and edition notes', () => {
  assert.equal(normalise('Melody Day (Four Tet Remix) [feat. Luke Lalonde, Adem & One Little Plane] [Mixed]'), 'melody day four tet remix');
  assert.equal(normalise('Back to Basics (feat. Skepta)'), 'back to basics');
  assert.equal(normalise('Song - Remastered 2011'), 'song');
  assert.equal(similarity('Locked', 'locked'), 1);
  assert.equal(containment('Caribou', 'Caribou, Luke Lalonde, Adem'), 1);
});

test('YouTube Music candidates must match title, artist and roughly the length', () => {
  const want = { title: 'Locked', artist: 'Four Tet', duration: 509.5 };
  assert.ok(acceptable(scoreCandidate(want, { title: 'Locked', artist: 'Four Tet', duration: 510 })));
  assert.ok(!acceptable(scoreCandidate(want, { title: 'Locked', artist: 'Someone Else', duration: 510 })));
  assert.ok(!acceptable(scoreCandidate(want, { title: 'Locked Out', artist: 'Four Tet', duration: 200 })));
  // A DJ-mix edit: exact title and artist, different length.
  const mixed = { title: 'Melody Day (Four Tet Remix) [Mixed]', artist: 'Caribou', duration: 200 };
  assert.ok(acceptable(scoreCandidate(mixed, { title: 'Melody Day (Four Tet Remix) (feat. Adem)', artist: 'Caribou, Adem', duration: 286 })));
});

test('stream links expire when googlevideo says so', () => {
  assert.equal(urlExpiry('https://rr1---sn.googlevideo.com/videoplayback?expire=1800000000&x=1'), 1800000000 * 1000);
  assert.ok(urlExpiry('https://example.com/a') > Date.now());
});

test('video titles lose the "Artist - " prefix before matching', () => {
  const { videoTitleWithoutArtist } = require('../app/main/youtube-music');
  assert.equal(videoTitleWithoutArtist('Bullet For My Valentine - Hand Of Blood (Official Audio)', 'Bullet For My Valentine'), 'Hand Of Blood (Official Audio)');
  assert.equal(videoTitleWithoutArtist('Hand Of Blood', 'Bullet For My Valentine'), 'Hand Of Blood');
  assert.equal(videoTitleWithoutArtist('Someone Else - Hand Of Blood', 'Bullet For My Valentine'), 'Someone Else - Hand Of Blood');
});

test('full songs come straight from YouTube (no yt-dlp): matched from Music search, preparing the next 20, one at a time', async () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-ytm-'));
  const prevYtDlp = process.env.HIVE_YTDLP, prevHome = process.env.HOME;
  process.env.HIVE_YTDLP = ''; process.env.HOME = dir; // no yt-dlp anywhere
  const row = (id, title, sub) => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId: id }, flexColumns: [title, sub].map(t => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: t }] } } })) } });
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    const json = o => ({ ok: true, status: 200, json: async () => o });
    if (url.includes('/search')) return json({ responseContext: { visitorData: 'V1' }, contents: [row('live1', 'Roxanne (Live)', 'The Police • Live! • 4:10'), row('orig1', 'Roxanne', "The Police • Outlandos d'Amour • 3:12")] });
    if (url.includes('/player')) {
      const id = JSON.parse(opts.body).videoId;
      return json({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId: id, title: 'Roxanne', author: 'The Police - Topic', lengthSeconds: '192' },
        streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4', bitrate: 130000, url: 'https://rr.googlevideo.com/a?expire=9999999999' }, { mimeType: 'audio/webm; codecs="opus"', bitrate: 140000, url: 'https://rr.googlevideo.com/b?expire=9999999999' }] } });
    }
    throw new Error('unexpected ' + url);
  };
  try {
    const m = create({ userDataDir: dir, net: { fetch } });
    const r = await m.resolve({ path: 'ytm:apple:1', title: 'Roxanne', artist: 'The Police', album: "Outlandos d'Amour", duration: 192 });
    assert.equal(r.videoId, 'orig1', 'the studio recording, not the live one');
    assert.equal(r.youtube.album, "Outlandos d'Amour");
    assert.match(r.streamUrl, /\/b\?/, 'Opus is preferred');
    assert.equal((await m.status()).installed, true);
    // Already matched: no search again.
    const before = calls.filter(u => u.includes('/search')).length;
    await m.resolve({ path: 'ytm:apple:1', title: 'Roxanne', artist: 'The Police', duration: 192 });
    assert.equal(calls.filter(u => u.includes('/search')).length, before);
    // A queue of 40 streamed songs prepares the next 20 (one at a time: two in the first second).
    calls.length = 0;
    const queued = await m.prefetch(Array.from({ length: 40 }, (_, i) => ({ path: `ytm:apple:x${i}`, title: 'Roxanne', artist: 'The Police', duration: 192 })));
    assert.equal(queued, 20);
    await new Promise(res => setTimeout(res, 1000));
    assert.ok(calls.filter(u => u.includes('/search')).length <= 2, `${calls.filter(u => u.includes('/search')).length} searches in the first second`);
  } finally {
    process.env.HIVE_YTDLP = prevYtDlp ?? ''; if (prevYtDlp === undefined) delete process.env.HIVE_YTDLP; process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
