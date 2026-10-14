'use strict';

// Readers for a MusicBee library folder (MusicBeeLibrary.mbl, *.mbp static
// playlists, *.xautopf auto playlists) plus the plan that maps it onto Hive's
// library. Formats were worked out from the shipped MusicBee 3.x files and
// the field numbering its plugin API/TagCode enum uses; nothing here loads
// or runs MusicBee code.

const path = require('path');

// MusicBee's TagCode byte for each tag stored in a library record. Only the
// codes Hive can use are named; everything else is kept under its number.
const TAG_NAMES = new Map([
  [27, 'persistentId'], [30, 'album'], [31, 'albumArtist'], [32, 'artist'],
  [41, 'bpm'], [43, 'composer'], [44, 'comment'], [45, 'conductor'],
  [46, 'custom1'], [47, 'custom2'], [48, 'custom3'], [49, 'custom4'], [50, 'custom5'],
  [52, 'disc'], [54, 'discCount'], [55, 'encoder'], [59, 'genre'], [61, 'grouping'],
  [62, 'lyricist'], [64, 'mood'], [65, 'title'], [66, 'occasion'], [73, 'publisher'],
  [75, 'ratingTag'], [76, 'love'], [86, 'track'], [87, 'trackCount'], [88, 'year'],
  [104, 'albumRating']
]);

// Record kinds (first byte of each record). 1 ends the file.
const RECORD_KINDS = { 2: 'music', 3: 'other', 4: 'inbox', 5: 'video', 6: 'podcast', 7: 'audiobook', 8: 'other', 9: 'other' };

// .NET DateTime.ToBinary(): low 62 bits are 100ns ticks since 0001-01-01,
// the top two bits the DateTimeKind. 0 means "never".
const DOTNET_EPOCH_TICKS = 621355968000000000n;
function dotNetBinaryToMs(raw) {
  const ticks = BigInt.asUintN(64, raw) & 0x3FFFFFFFFFFFFFFFn;
  if (ticks === 0n || ticks < DOTNET_EPOCH_TICKS) return 0;
  return Number((ticks - DOTNET_EPOCH_TICKS) / 10000n);
}

function createReader(buffer) {
  let pos = 0;
  const need = (n) => { if (pos + n > buffer.length) throw new Error(`MusicBee file ends early at byte ${pos}.`); };
  return {
    get pos() { return pos; },
    u8() { need(1); return buffer[pos++]; },
    u16() { need(2); const v = buffer.readUInt16LE(pos); pos += 2; return v; },
    i16() { need(2); const v = buffer.readInt16LE(pos); pos += 2; return v; },
    i32() { need(4); const v = buffer.readInt32LE(pos); pos += 4; return v; },
    i64() { need(8); const v = buffer.readBigInt64LE(pos); pos += 8; return v; },
    // BinaryWriter.Write(string): 7-bit encoded byte length, then UTF-8.
    str() {
      let len = 0, shift = 0, byte;
      do { byte = this.u8(); len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
      need(len);
      const v = buffer.toString('utf8', pos, pos + len); pos += len; return v;
    }
  };
}

function parseMusicBeeLibrary(buffer) {
  const r = createReader(buffer);
  const header = r.i32();
  if ((header & 0xff) !== 1) throw new Error('Not a MusicBee library file (unknown version).');
  const declaredCount = header >>> 8;
  const records = [];
  for (;;) {
    const kind = r.u8();
    if (kind === 1) break;
    if (!RECORD_KINDS[kind]) throw new Error(`Unexpected MusicBee record type ${kind} at byte ${r.pos - 1}.`);
    r.u8(); // record status
    const rating = r.u8();
    const playCount = r.u16();
    const lastPlayedAt = dotNetBinaryToMs(r.i64());
    const skipCount = r.u16();
    const record = {
      kind: RECORD_KINDS[kind],
      rating: rating === 255 ? null : rating, // 0-100, null = unrated
      playCount, skipCount, lastPlayedAt,
      path: r.str(),
      size: r.i32(),
      sampleRate: r.i32(),
      channels: r.u8(),
      bitrateMode: r.u8(),
      bitrate: r.i16(),
      durationMs: r.i32()
    };
    record.dateAddedAt = dotNetBinaryToMs(r.i64());
    record.dateModifiedAt = dotNetBinaryToMs(r.i64());
    // Artwork slots: (type, text, source, location) until 0xFF; 0xFE marks an
    // embedded-artwork placeholder with no fields.
    for (;;) {
      const b = r.u8();
      if (b === 255) break;
      if (b === 254) continue;
      r.str(); r.u8(); r.str();
    }
    r.u8(); // artwork flags
    const tags = {};
    for (;;) {
      const code = r.u8();
      if (code === 0) break;
      if (code === 255) {
        // Cue-sheet sub-tracks: per-part rating/plays/last played/skips.
        const parts = r.i16();
        for (let i = 0; i < parts; i++) { r.u8(); r.u16(); r.i64(); r.u16(); }
        break;
      }
      const value = r.str();
      if (value !== '') tags[TAG_NAMES.get(code) || String(code)] = value;
    }
    record.tags = tags;
    record.loved = tags.love === 'L';
    record.banned = tags.love === 'B';
    records.push(record);
  }
  return { declaredCount, records };
}

// *.mbp: a header (library path and view settings), then an Int32 count and
// that many (path string, Int32) pairs to the end of the file. The header has
// varied between versions, so find the offset where the entry list parses
// exactly to EOF instead of hard-coding its length.
function parseMusicBeePlaylist(buffer) {
  const looksLikePath = s => s.length > 3 && (/^[A-Za-z]:\\/.test(s) || s.startsWith('\\') || s.includes('://'));
  for (let offset = 4; offset < Math.min(buffer.length - 4, 1024); offset++) {
    const count = buffer.readInt32LE(offset);
    if (count < 0 || count > 1000000) continue;
    try {
      const r = createReader(buffer.subarray(offset + 4));
      const paths = [];
      for (let i = 0; i < count; i++) {
        const p = r.str();
        if (!looksLikePath(p)) throw new Error('not a path');
        r.i32();
        paths.push(p);
      }
      if (offset + 4 + r.pos === buffer.length) return paths;
    } catch {}
  }
  throw new Error('Could not find the track list in this MusicBee playlist.');
}

const decodeXml = s => String(s || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const xmlAttrs = tag => Object.fromEntries([...String(tag).matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map(m => [m[1], decodeXml(m[2])]));

// MusicBee condition field -> Hive smart-playlist field.
const AUTO_FIELDS = {
  FilePlayCount: 'plays', FileSkipCount: 'skipCount', FileDateAdded: 'addedAt', AlbumDateAdded: 'addedAt',
  FileLastPlayed: 'lastPlayedAt', AlbumLastPlayed: 'lastPlayedAt', Rating: 'rating', RatingLoveBan: 'love',
  TrackTitle: 'title', Title: 'title', Artist: 'artist', ArtistPeople: 'artist', AlbumArtist: 'albumArtist',
  Album: 'album', Genre: 'genre', Year: 'year', YearOnly: 'year', Composer: 'composer', Comment: 'comment',
  Grouping: 'grouping', Publisher: 'publisher', Mood: 'mood', Occasion: 'occasion', FileDuration: 'duration',
  FileBitrate: 'bitrate', FileSampleRate: 'sampleRate', TrackNo: 'track', DiscNo: 'disc', FileKind: 'codec',
  FileUrl: 'path', FilePath: 'path'
};
const AUTO_OPS = {
  Is: 'is', IsNot: 'not', Contains: 'contains', DoesNotContain: 'notcontains', StartsWith: 'starts', EndsWith: 'ends',
  GreaterThan: 'gt', LessThan: 'lt', GreaterThanOrEqual: 'gte', LessThanOrEqual: 'lte', InTheLast: 'inLast', NotInTheLast: 'notInLast',
  IsNotNull: 'notempty', IsNull: 'empty'
};
// SortBy/DefinedSort use TagCode numbers.
const AUTO_SORTS = { 14: 'playsDesc', 12: 'addedDesc', 180: 'addedDesc', 13: 'lastPlayedDesc', 181: 'lastPlayedDesc', 75: 'ratingDesc', 65: 'title', 32: 'artist', 30: 'album' };
const AUTO_SELECTED_BY = { MostOftenPlayed: 'playsDesc', LeastOftenPlayed: 'playsDesc', MostRecentlyPlayed: 'lastPlayedDesc', MostRecentlyAdded: 'addedDesc', HighestRating: 'ratingDesc', Random: 'random' };

function parseMusicBeeAutoPlaylist(xmlText, name = '') {
  const xml = String(xmlText || '').replace(/^\uFEFF/, '');
  if (!/<SmartPlaylist\b/.test(xml)) throw new Error('Not a MusicBee auto playlist.');
  const root = xmlAttrs((xml.match(/<SmartPlaylist\b[^>]*>/) || [''])[0]);
  const conditionsTag = xmlAttrs((xml.match(/<Conditions\b[^>]*>/) || [''])[0]);
  const description = decodeXml((xml.match(/<Description>([\s\S]*?)<\/Description>/) || ['', ''])[1]).trim();
  const unsupported = [];
  const rules = [];
  for (const m of xml.matchAll(/<Condition\b[^>]*\/?>/g)) {
    const c = xmlAttrs(m[0]);
    const field = AUTO_FIELDS[c.Field];
    const op = AUTO_OPS[c.Comparison];
    if (!field || !op) { unsupported.push(`${c.Field} ${c.Comparison} ${c.Value ?? ''}`.trim()); continue; }
    let value = c.Value ?? '';
    if (field === 'love') value = value === 'L' ? 'Loved' : value === 'B' ? 'Banned' : value;
    if (field === 'rating' && value !== '' && Number.isFinite(Number(value))) value = String(Number(value) / 20);
    if (field === 'duration' && /^\d+$/.test(value)) value = String(Number(value) / 1000);
    rules.push({ field, op, value });
  }
  const limitTag = xmlAttrs((xml.match(/<Limit\b[^>]*\/?>/) || [''])[0]);
  const sortTag = xmlAttrs((xml.match(/<(?:SortBy|DefinedSort)\b[^>]*\/?>/) || [''])[0]);
  const limited = limitTag.Enabled === 'True' && Number(limitTag.Count) > 0;
  let sort = AUTO_SORTS[Number(sortTag.Field ?? sortTag.Id)] || 'addedDesc';
  if (limited && AUTO_SELECTED_BY[limitTag.SelectedBy]) sort = AUTO_SELECTED_BY[limitTag.SelectedBy];
  if (limited && limitTag.Type && limitTag.Type !== 'Items') unsupported.push(`limit by ${limitTag.Type}`);
  return {
    name,
    description,
    match: conditionsTag.CombineMethod === 'Any' ? 'any' : 'all',
    rules,
    limit: limited ? Number(limitTag.Count) : 0,
    sort,
    smartShuffle: root.ShuffleMode === 'Random' ? 'random' : 'none',
    filterDuplicates: limitTag.FilterDuplicates === 'True',
    unsupported
  };
}

// MusicBee stores paths with Windows separators, relative to the drive root
// of its music folder (or absolute in playlists). Match by file name, then
// break ties with duration and title, since Hive's library may live
// somewhere else entirely (it does here: ~/Music vs D:\beautiful sounds pc).
function createTrackMatcher(tracks) {
  const byName = new Map();
  for (const track of tracks) {
    if (!track?.path) continue;
    const key = path.basename(track.path).toLowerCase();
    const list = byName.get(key);
    if (list) list.push(track); else byName.set(key, [track]);
  }
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  // Files renamed after leaving MusicBee still match on title + artist when
  // exactly one track with that pair also has the same length.
  const byTitleArtist = new Map();
  for (const track of tracks) {
    if (!track?.path || !track.title) continue;
    const key = `${norm(track.title)}\u0000${norm(track.artist)}`;
    const list = byTitleArtist.get(key);
    if (list) list.push(track); else byTitleArtist.set(key, [track]);
  }
  const byTags = (hint) => {
    if (!hint.title) return null;
    const list = (byTitleArtist.get(`${norm(hint.title)}\u0000${norm(hint.artist)}`) || [])
      .filter(t => !hint.durationMs || Math.abs(Number(t.duration || 0) * 1000 - hint.durationMs) < 2000);
    return list.length === 1 ? list[0] : null;
  };
  return function match(musicBeePath, hint = {}) {
    const name = String(musicBeePath || '').split(/[\\/]/).pop().toLowerCase();
    const candidates = byName.get(name) || [];
    if (!candidates.length) return byTags(hint);
    if (candidates.length === 1) return candidates[0];
    let best = candidates;
    if (hint.durationMs) {
      const close = best.filter(t => Math.abs(Number(t.duration || 0) * 1000 - hint.durationMs) < 2000);
      if (close.length) best = close;
    }
    if (best.length > 1 && hint.title) {
      const titled = best.filter(t => norm(t.title) === norm(hint.title));
      if (titled.length) best = titled;
    }
    return best.length === 1 ? best[0] : null;
  };
}

function ratingToStars(rating) {
  if (rating == null) return 0;
  return Math.max(0, Math.min(5, Math.round(rating / 10) / 2));
}

// Merge rule: never lose information either side has. Counts take the larger
// value (Hive may already hold MusicBee Wrapped imports, so adding would
// double count), last played the later time, date added the earlier time.
// Ratings and Love only fill in where Hive has none, so an edit made in Hive
// after leaving MusicBee is never overwritten.
function buildMusicBeeImportPlan({ records, tracks, stats = {} }) {
  const match = createTrackMatcher(tracks);
  const plan = { matched: 0, unmatched: 0, statUpdates: {}, addedAt: {}, ratingJobs: [], loveJobs: [], unmatchedSamples: [] };
  for (const record of records) {
    if (record.kind !== 'music') continue;
    const track = match(record.path, { durationMs: record.durationMs, title: record.tags.title, artist: record.tags.artist });
    if (!track) {
      plan.unmatched++;
      if (plan.unmatchedSamples.length < 20) plan.unmatchedSamples.push(record.path);
      continue;
    }
    plan.matched++;
    const current = stats[track.path] || {};
    const hivePlays = Number(current.playCount ?? track.playCount ?? 0);
    const hiveSkips = Number(current.skipCount ?? track.skipCount ?? 0);
    const hiveLast = Number(current.lastPlayedAt ?? track.lastPlayedAt ?? 0);
    const next = {
      playCount: Math.max(hivePlays, record.playCount),
      skipCount: Math.max(hiveSkips, record.skipCount),
      lastPlayedAt: Math.max(hiveLast, record.lastPlayedAt)
    };
    if (next.playCount !== hivePlays || next.skipCount !== hiveSkips || next.lastPlayedAt !== hiveLast) {
      plan.statUpdates[track.path] = { ...current, ...next };
    }
    if (record.dateAddedAt && (!track.addedAt || record.dateAddedAt < Number(track.addedAt))) {
      plan.addedAt[track.path] = record.dateAddedAt;
    }
    const stars = ratingToStars(record.rating);
    if (stars > 0 && !Number(track.rating)) plan.ratingJobs.push({ kind: 'rating', path: track.path, rating: stars });
    if (record.loved && !track.loved) plan.loveJobs.push({ kind: 'love', path: track.path, loved: true });
  }
  return plan;
}

// MusicBee3Settings.ini is XML: <ApplicationSettings><Key>value</Key>...
function parseMusicBeeSettings(xmlText) {
  const out = {};
  for (const m of String(xmlText || '').matchAll(/<([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/\1>/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

const SHUFFLE_BY = { 0: 'track', 1: 'album', 2: 'artist', 3: 'grouping', 4: 'work' };
const REPLAYGAIN_TYPE = { 0: 'track', 1: 'album', 2: 'smart' };

// The subset of MusicBee's player settings Hive implements, in Hive's
// own shape. Keys MusicBee didn't write are left out so they don't override.
function mapMusicBeeSettings(raw) {
  const bool = k => (raw[k] === undefined ? undefined : String(raw[k]).toLowerCase() === 'true');
  const num = k => (raw[k] === undefined || raw[k] === '' ? undefined : Number(String(raw[k]).replace(',', '.')));
  const prefs = {};
  const set = (key, value) => { if (value !== undefined && !Number.isNaN(value)) prefs[key] = value; };
  set('popup.enabled', bool('PlayerPopupEnabled'));
  set('popup.inactiveOnly', bool('PlayerPopupWhenInactiveOnly'));
  if (num('PlayerPopupDuration') !== undefined) set('popup.seconds', Math.max(1, Math.round(num('PlayerPopupDuration') / 1000)));
  if (num('PlayerShuffleBy') !== undefined) set('shuffle.by', SHUFFLE_BY[num('PlayerShuffleBy')] || 'track');
  if (num('PlayerShuffleSameArtistBias') !== undefined) set('shuffle.sameArtistBias', num('PlayerShuffleSameArtistBias') > 0 ? 1 : 0);
  const equaliser = {};
  if (bool('PlayerEqualiserEnabled') !== undefined) equaliser.enabled = bool('PlayerEqualiserEnabled');
  if (raw.PlayerEqualiserName) equaliser.mode = raw.PlayerEqualiserName;
  const dsp = {};
  if (Object.keys(equaliser).length) dsp.equaliser = equaliser;
  if (num('PlayerStereoBalance') !== undefined) dsp.balance = Math.max(-1, Math.min(1, num('PlayerStereoBalance')));
  let replayGainMode;
  if (bool('PlayerReplayGainActive') !== undefined) {
    replayGainMode = bool('PlayerReplayGainActive') ? (REPLAYGAIN_TYPE[num('PlayerReplayGainType')] || 'track') : 'off';
  }
  return { prefs, dsp, replayGainMode };
}

module.exports = {
  parseMusicBeeSettings,
  mapMusicBeeSettings,
  parseMusicBeeLibrary,
  parseMusicBeePlaylist,
  parseMusicBeeAutoPlaylist,
  createTrackMatcher,
  buildMusicBeeImportPlan,
  ratingToStars,
  dotNetBinaryToMs
};
