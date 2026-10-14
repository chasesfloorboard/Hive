const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMusicBeeLibrary, parseMusicBeePlaylist, parseMusicBeeAutoPlaylist, buildMusicBeeImportPlan, dotNetBinaryToMs
} = require('../app/main/musicbee-library');

// Minimal .NET BinaryWriter equivalents for building fixtures.
const u8 = v => Buffer.from([v]);
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i16 = v => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const dotNetDate = ms => { const b = Buffer.alloc(8); b.writeBigUInt64LE(ms ? ((BigInt(ms) * 10000n + 621355968000000000n) | (1n << 62n)) : 0n); return b; };
const str = s => { const body = Buffer.from(s, 'utf8'); const len = []; let n = body.length; do { let c = n & 0x7f; n >>= 7; if (n) c |= 0x80; len.push(c); } while (n); return Buffer.concat([Buffer.from(len), body]); };

function record({ path, rating = 255, plays = 0, lastPlayed = 0, skips = 0, durationMs = 200000, added, modified, tags = [] }) {
  return Buffer.concat([
    u8(2), u8(1), u8(rating), u16(plays), dotNetDate(lastPlayed), u16(skips), str(path),
    i32(1234), i32(44100), u8(2), u8(1), i16(320), i32(durationMs), dotNetDate(added), dotNetDate(modified),
    u8(3), str(''), u8(1), str(''), u8(255), // one artwork slot, end of slots
    u8(3),
    ...tags.flatMap(([code, value]) => [u8(code), str(value)]),
    u8(0)
  ]);
}

const ADDED = Date.UTC(2024, 8, 12, 8, 22, 50);
const PLAYED = Date.UTC(2024, 8, 12, 21, 45, 55);

function libraryFixture() {
  const records = [
    record({ path: '\\music\\01 Since I Left You.mp3', plays: 12, lastPlayed: PLAYED, skips: 1, durationMs: 263000, added: ADDED, modified: ADDED - 1000,
      tags: [[65, 'Since I Left You'], [32, 'The Avalanches'], [30, 'Since I Left You'], [76, 'L']] }),
    record({ path: '\\music\\04 Radio.mp3', rating: 100, plays: 13, added: ADDED, modified: ADDED, tags: [[65, 'Radio'], [32, 'The Avalanches']] }),
    record({ path: '\\music\\Gone.mp3', added: ADDED, modified: ADDED, tags: [[65, 'Gone']] })
  ];
  return Buffer.concat([i32((records.length << 8) | 1), ...records, u8(1)]);
}

test('parses MusicBee library records: stats, dates, rating, Love and tags', () => {
  const { declaredCount, records } = parseMusicBeeLibrary(libraryFixture());
  assert.equal(declaredCount, 3);
  assert.equal(records.length, 3);
  const [first, second] = records;
  assert.equal(first.path, '\\music\\01 Since I Left You.mp3');
  assert.equal(first.playCount, 12);
  assert.equal(first.skipCount, 1);
  assert.equal(first.lastPlayedAt, PLAYED);
  assert.equal(first.dateAddedAt, ADDED);
  assert.equal(first.durationMs, 263000);
  assert.equal(first.rating, null);
  assert.equal(first.loved, true);
  assert.deepEqual(first.tags, { title: 'Since I Left You', artist: 'The Avalanches', album: 'Since I Left You', love: 'L' });
  assert.equal(second.rating, 100);
});

test('rejects a file that is not a MusicBee library', () => {
  assert.throws(() => parseMusicBeeLibrary(Buffer.from([7, 0, 0, 0, 1])), /Not a MusicBee library/);
});

test('.NET DateTime binary values convert to epoch ms, and 0 means never', () => {
  assert.equal(dotNetBinaryToMs(0n), 0);
  assert.equal(dotNetBinaryToMs(dotNetDate(ADDED).readBigInt64LE(0)), ADDED);
});

test('parses a static .mbp playlist whatever its header length', () => {
  const header = Buffer.concat([i32(4), Buffer.from('\u0026\u0000\u0000D:\\MusicBee\\Lib\\\u00000\u0000False\u0000\u0000-2\u0000'), u16(4), i32(-1), i32(0), i32(-1)]);
  const entries = ['D:\\music\\a.mp3', 'D:\\music\\b.flac'].flatMap(p => [str(p), i32(-1)]);
  assert.deepEqual(parseMusicBeePlaylist(Buffer.concat([header, i32(2), ...entries])), ['D:\\music\\a.mp3', 'D:\\music\\b.flac']);
});

test('converts MusicBee auto playlists to Hive smart playlist rules', () => {
  const top = parseMusicBeeAutoPlaylist(`\uFEFF<?xml version="1.0"?><SmartPlaylist ShuffleMode="None"><Source Type="1"><Conditions CombineMethod="All"><Condition Field="FilePlayCount" Comparison="GreaterThan" Value="0" /></Conditions><Limit FilterDuplicates="False" Enabled="True" Count="25" Type="Items" SelectedBy="MostOftenPlayed" /><SortBy Field="14" Order="Descending" /></Source></SmartPlaylist>`, 'Top 25');
  assert.deepEqual(top.rules, [{ field: 'plays', op: 'gt', value: '0' }]);
  assert.equal(top.limit, 25);
  assert.equal(top.sort, 'playsDesc');

  const fav = parseMusicBeeAutoPlaylist(`<SmartPlaylist ShuffleMode="Random"><Source Type="1"><Description>only da best</Description><Conditions CombineMethod="Any"><Condition Field="RatingLoveBan" Comparison="Is" Value="L" /><Condition Field="Rating" Comparison="GreaterThan" Value="80" /><Condition Field="Weird" Comparison="Is" Value="x" /></Conditions></Source></SmartPlaylist>`, 'Favorites');
  assert.equal(fav.match, 'any');
  assert.equal(fav.smartShuffle, 'random');
  assert.equal(fav.description, 'only da best');
  assert.deepEqual(fav.rules, [{ field: 'love', op: 'is', value: 'Loved' }, { field: 'rating', op: 'gt', value: '4' }]);
  assert.deepEqual(fav.unsupported, ['Weird Is x']);

  const recent = parseMusicBeeAutoPlaylist(`<SmartPlaylist><Conditions CombineMethod="All"><Condition Field="AlbumDateAdded" Comparison="InTheLast" Value="6m" /></Conditions></SmartPlaylist>`, 'Recent');
  assert.deepEqual(recent.rules, [{ field: 'addedAt', op: 'inLast', value: '6m' }]);
});

test('import plan never lowers Hive data and only fills missing ratings/Love', () => {
  const { records } = parseMusicBeeLibrary(libraryFixture());
  const tracks = [
    { path: '/home/u/Music/01 Since I Left You.mp3', title: 'Since I Left You', duration: 263, addedAt: Date.UTC(2026, 9, 1), rating: 0, loved: false },
    { path: '/home/u/Music/renamed radio.mp3', title: 'Radio', artist: 'The Avalanches', duration: 200, addedAt: Date.UTC(2026, 9, 1), rating: 3, loved: false }
  ];
  const stats = { '/home/u/Music/01 Since I Left You.mp3': { playCount: 20, lastPlayedAt: 1 } };
  const plan = buildMusicBeeImportPlan({ records, tracks, stats });
  assert.equal(plan.matched, 2, 'file name match plus title/artist/duration fallback for the renamed file');
  assert.equal(plan.unmatched, 1);
  const first = plan.statUpdates['/home/u/Music/01 Since I Left You.mp3'];
  assert.equal(first.playCount, 20, 'Hive already counted more plays; keep the higher number');
  assert.equal(first.skipCount, 1);
  assert.equal(first.lastPlayedAt, PLAYED);
  assert.equal(plan.statUpdates['/home/u/Music/renamed radio.mp3'].playCount, 13);
  assert.equal(plan.addedAt['/home/u/Music/01 Since I Left You.mp3'], ADDED);
  assert.deepEqual(plan.loveJobs, [{ kind: 'love', path: '/home/u/Music/01 Since I Left You.mp3', loved: true }]);
  assert.deepEqual(plan.ratingJobs, [], 'the rated track already has a Hive rating, which wins');
});

test('maps MusicBee player settings onto Hive settings', () => {
  const { parseMusicBeeSettings, mapMusicBeeSettings } = require('../app/main/musicbee-library');
  const xml = `<?xml version="1.0" encoding="utf-8"?><ApplicationSettings>
<PlayerEqualiserEnabled>true</PlayerEqualiserEnabled>
<PlayerEqualiserName>-2db EQUAL WITH WINDOWS</PlayerEqualiserName>
<PlayerStereoBalance>-0.25</PlayerStereoBalance>
<PlayerReplayGainActive>true</PlayerReplayGainActive>
<PlayerReplayGainType>2</PlayerReplayGainType>
<PlayerShuffleBy>1</PlayerShuffleBy>
<PlayerShuffleSameArtistBias>0.5</PlayerShuffleSameArtistBias>
<PlayerPopupEnabled>true</PlayerPopupEnabled>
<PlayerPopupDuration>6000</PlayerPopupDuration>
</ApplicationSettings>`;
  const mapped = mapMusicBeeSettings(parseMusicBeeSettings(xml));
  assert.deepEqual(mapped.dsp, { equaliser: { enabled: true, mode: '-2db EQUAL WITH WINDOWS' }, balance: -0.25 });
  assert.equal(mapped.replayGainMode, 'smart');
  assert.deepEqual(mapped.prefs, { 'popup.enabled': true, 'popup.seconds': 6, 'shuffle.by': 'album', 'shuffle.sameArtistBias': 1 });
  assert.equal(mapMusicBeeSettings(parseMusicBeeSettings('<A><PlayerReplayGainActive>false</PlayerReplayGainActive></A>')).replayGainMode, 'off');
});
