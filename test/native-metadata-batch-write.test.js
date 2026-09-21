const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native metadata batch writes tags and artwork in one media save', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-batch-tags-'));
  const mp3 = path.join(tempDir, 'album-track.mp3');
  const image = path.join(tempDir, 'back.jpg');
  const script = String.raw`
import json, sys
from pathlib import Path
sys.path.insert(0, '..')
from mutagen.id3 import ID3, APIC
import tag_helper
p = Path(sys.argv[1]); image = Path(sys.argv[2])
ID3().save(p, v2_version=3, v1=0)
front = APIC(encoding=3, mime='image/jpeg', type=3, desc='front', data=b'front-image')
tag = ID3(p); tag.add(front); tag.save(v2_version=3, v1=0)
count = {'save': 0}
orig_save = ID3.save
def counted_save(self, *args, **kwargs):
    count['save'] += 1
    return orig_save(self, *args, **kwargs)
ID3.save = counted_save
image.write_bytes(b'back-image')
tag_helper.write_metadata(str(p), {'album': 'Optimized Album', 'albumArtist': 'Hive Artist'}, {'action':'add','imagePath':str(image),'pictureType':'Cover (Back)','comment':'back'})
final = ID3(p)
print(json.dumps({
  'saveCount': count['save'],
  'album': final['TALB'].text[0],
  'albumArtist': final['TPE2'].text[0],
  'pictures': [(int(frame.type), str(frame.desc), bytes(frame.data).decode('latin1')) for frame in final.getall('APIC')]
}))
`;
  try {
    const result = spawnSync('python3', ['-c', script, mp3, image], { cwd: path.resolve(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.saveCount, 1);
    assert.equal(out.album, 'Optimized Album');
    assert.equal(out.albumArtist, 'Hive Artist');
    assert.equal(out.pictures.length, 2);
    assert.deepEqual(out.pictures.map(p => p[0]).sort((a,b)=>a-b), [3,4]);
    assert.ok(out.pictures.some(p => p[0] === 3 && p[2] === 'front-image'));
    assert.ok(out.pictures.some(p => p[0] === 4 && p[2] === 'back-image'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// A user's advanced/custom tags box in the tag editor is populated from a
// raw dump of every native tag the file already has (see editorNativeObject
// in renderer.js), which can include a bare "LYRICS"/"USLT" duplicating the
// dedicated Lyrics field. Saving plain lyrics while a stale synced-lyrics
// value still sits in that raw duplicate must not let the duplicate win --
// the write reported "expected <plain>, read back <old synced LRC text>"
// because write_flac/write_mp3's custom-field loop re-wrote the standard
// field a second time from whichever key happened to iterate last.
test('a stale duplicate custom tag cannot overwrite a standard field written in the same save (FLAC + MP3)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-lyrics-collision-'));
  const flac = path.join(tempDir, 'track.flac');
  const mp3 = path.join(tempDir, 'track.mp3');
  // FLAC's tag writer needs a real FLAC stream to attach metadata blocks to
  // (mutagen.flac.FLAC() cannot save() a brand-new empty path); synthesize a
  // minimal silent one.
  const ffmpegFlac = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.1', flac], { encoding: 'utf8' });
  assert.equal(ffmpegFlac.status, 0, ffmpegFlac.stderr);
  const script = String.raw`
import json, sys
sys.path.insert(0, '..')
import tag_helper

results = {}

# FLAC: a raw "LYRICS" custom key (any case that upper()s to LYRICS) must not
# clobber the plain 'lyrics' field the standard writer already set.
tag_helper.write_metadata(sys.argv[1], {'lyrics': 'plain lyrics', 'LYRICS': '[00:01.00] stale synced lyrics'})
results['flac_lyrics'] = tag_helper.read_metadata_fields(sys.argv[1], ['lyrics'])['lyrics']

# MP3: a raw "USLT" custom key must not clobber the same field set via 'lyrics'.
from mutagen.id3 import ID3
ID3().save(sys.argv[2], v2_version=3, v1=0)
tag_helper.write_metadata(sys.argv[2], {'lyrics': 'plain lyrics', 'USLT': '[00:01.00] stale synced lyrics'})
results['mp3_lyrics'] = tag_helper.read_metadata_fields(sys.argv[2], ['lyrics'])['lyrics']

print(json.dumps(results))
`;
  try {
    const result = spawnSync('python3', ['-c', script, flac, mp3], { cwd: path.resolve(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.flac_lyrics, 'plain lyrics');
    assert.equal(out.mp3_lyrics, 'plain lyrics');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// The tag editor's ReplayGain/R128 inputs write real named metadata fields
// (REPLAYGAIN_TRACK_GAIN etc.) rather than a Hive-only format, per the
// comment above that save-time block in renderer.js. For MP3, write_mp3's
// custom-field loop only handled bare 4-char frame ids, TXXX:-prefixed keys,
// and a fixed allowlist (p_count/custom*/BEEHIVE_*/...) -- a long named key
// like "REPLAYGAIN_TRACK_GAIN" matched none of those branches and was
// silently dropped, so editing ReplayGain in Settings did nothing for MP3s.
test('ReplayGain/R128 fields survive a write for MP3 (and FLAC, which already worked)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-replaygain-'));
  const mp3 = path.join(tempDir, 'track.mp3');
  const flac = path.join(tempDir, 'track.flac');
  const ffmpegFlac = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.1', flac], { encoding: 'utf8' });
  assert.equal(ffmpegFlac.status, 0, ffmpegFlac.stderr);
  const script = String.raw`
import json, sys
sys.path.insert(0, '..')
import tag_helper
from mutagen.id3 import ID3

fields = {'REPLAYGAIN_TRACK_GAIN': '-6.50 dB', 'REPLAYGAIN_TRACK_PEAK': '0.987', 'R128_TRACK_GAIN': '-3.2'}

ID3().save(sys.argv[1], v2_version=3, v1=0)
tag_helper.write_metadata(sys.argv[1], fields)
mp3_tag = ID3(sys.argv[1])
mp3_txxx = {(f.desc or '').upper(): str(f.text[0]) for f in mp3_tag.getall('TXXX')}

tag_helper.write_metadata(sys.argv[2], fields)
from mutagen.flac import FLAC
flac_tags = FLAC(sys.argv[2])

print(json.dumps({
  'mp3': {k: mp3_txxx.get(k) for k in fields},
  'flac': {k: (flac_tags.get(k) or [None])[0] for k in fields},
}))
`;
  try {
    const result = spawnSync('python3', ['-c', script, mp3, flac], { cwd: path.resolve(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.mp3.REPLAYGAIN_TRACK_GAIN, '-6.50 dB');
    assert.equal(out.mp3.REPLAYGAIN_TRACK_PEAK, '0.987');
    assert.equal(out.mp3.R128_TRACK_GAIN, '-3.2');
    assert.equal(out.flac.REPLAYGAIN_TRACK_GAIN, '-6.50 dB');
    assert.equal(out.flac.REPLAYGAIN_TRACK_PEAK, '0.987');
    assert.equal(out.flac.R128_TRACK_GAIN, '-3.2');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// The plain lyrics tag (USLT / FLAC LYRICS / MP4's freeform lyrics atom) is
// the field every player, including Hive's own "no embedded lyrics" fallback
// check, reads as ordinary text. It must never contain raw [mm:ss.xx]
// timestamps, even when the caller hands over a full LRC blob (e.g. an
// online lookup that preferred a synced result, or the tag editor's synced
// mode) -- only MP3's dedicated SYLT frame is allowed to carry timed text,
// and only when the caller explicitly asks for synced mode via LYRICS_SYNC.
test('embedding lyrics always strips LRC timestamps from the plain lyrics tag (MP3 + FLAC + MP4)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-lyrics-plain-'));
  const mp3 = path.join(tempDir, 'track.mp3');
  const mp3Synced = path.join(tempDir, 'track-synced.mp3');
  const flac = path.join(tempDir, 'track.flac');
  const m4a = path.join(tempDir, 'track.m4a');
  const lrc = '[00:01.00]first line\n[00:02.50]second line';
  const ffmpegFlac = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.1', flac], { encoding: 'utf8' });
  assert.equal(ffmpegFlac.status, 0, ffmpegFlac.stderr);
  const ffmpegM4a = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.1', '-c:a', 'aac', m4a], { encoding: 'utf8' });
  assert.equal(ffmpegM4a.status, 0, ffmpegM4a.stderr);
  const script = String.raw`
import json, sys
sys.path.insert(0, '..')
import tag_helper
from mutagen.id3 import ID3

results = {}
lrc = sys.argv[5]

ID3().save(sys.argv[1], v2_version=3, v1=0)
tag_helper.write_metadata(sys.argv[1], {'lyrics': lrc})
mp3_tag = ID3(sys.argv[1])
results['mp3_plain'] = str(mp3_tag.getall('USLT')[0].text)
results['mp3_sylt_absent'] = len(mp3_tag.getall('SYLT')) == 0

ID3().save(sys.argv[2], v2_version=3, v1=0)
tag_helper.write_metadata(sys.argv[2], {'lyrics': lrc, 'LYRICS_SYNC': 'synced'})
mp3_synced_tag = ID3(sys.argv[2])
results['mp3_synced_plain'] = str(mp3_synced_tag.getall('USLT')[0].text)
sylt = mp3_synced_tag.getall('SYLT')
results['mp3_sylt_present'] = len(sylt) == 1
results['mp3_sylt_entries'] = list(sylt[0].text) if sylt else []

tag_helper.write_metadata(sys.argv[3], {'lyrics': lrc})
results['flac_plain'] = tag_helper.read_metadata_fields(sys.argv[3], ['lyrics'])['lyrics']

tag_helper.write_metadata(sys.argv[4], {'lyrics': lrc})
results['m4a_plain'] = tag_helper.read_metadata_fields(sys.argv[4], ['lyrics'])['lyrics']

print(json.dumps(results))
`;
  try {
    const result = spawnSync('python3', ['-c', script, mp3, mp3Synced, flac, m4a, lrc], { cwd: path.resolve(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.mp3_plain, 'first line\nsecond line');
    assert.ok(out.mp3_sylt_absent, 'unsynced write must not leave a SYLT frame');
    assert.equal(out.mp3_synced_plain, 'first line\nsecond line', 'USLT must stay plain even when SYLT is also written');
    assert.ok(out.mp3_sylt_present, 'explicit synced mode must still write a real SYLT frame');
    assert.deepEqual(out.mp3_sylt_entries, [['first line', 1000], ['second line', 2500]]);
    assert.equal(out.flac_plain, 'first line\nsecond line');
    assert.equal(out.m4a_plain, 'first line\nsecond line');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Real files in the wild were found with a USLT frame whose language code is
// malformed junk -- three raw spaces, 'XXX', or null bytes -- rather than a
// real ISO 639-2 code. set_uslt's replace logic only cleared a frame whose
// lang matched 'eng'/'und'/'' *after* lower()-casing but without stripping,
// so a malformed-but-not-meaningfully-different lang byte sequence like
// '   ' never matched '' and was left behind as a second, stale USLT frame
// every time Hive wrote lyrics to that file -- silently duplicating the
// field instead of replacing it, so old synced text (with timestamps) sat
// permanently alongside newly-written plain text.
test('writing lyrics replaces a pre-existing USLT frame even when its language code is malformed junk, not just a real ISO code', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-lyrics-malformed-lang-'));
  const mp3 = path.join(tempDir, 'track.mp3');
  const script = String.raw`
import json, sys
sys.path.insert(0, '..')
import tag_helper
from mutagen.id3 import ID3, USLT

results = {}
# ID3's language field is a fixed 3-byte code, so a real malformed value is
# always exactly 3 bytes of *something* -- Mutagen itself won't construct a
# truly empty one, which is why '' isn't in this list even though
# is_default_lang treats it the same as the others.
for lang in ['   ', 'XXX', '\x00\x00\x00', 'eng', 'und']:
    ID3().save(sys.argv[1], v2_version=3, v1=0)
    tag = ID3(sys.argv[1])
    tag.add(USLT(encoding=3, lang=lang, desc='', text='[00:01.00]old synced garbage'))
    tag.save(sys.argv[1], v2_version=3, v1=0)
    tag_helper.write_metadata(sys.argv[1], {'lyrics': 'new plain lyrics'})
    after = ID3(sys.argv[1]).getall('USLT')
    results[repr(lang)] = {'count': len(after), 'text': str(after[0].text) if after else None}

# A genuinely different, real language must still be preserved as a
# distinct, separate frame -- this fix must not become "always delete
# everything".
ID3().save(sys.argv[1], v2_version=3, v1=0)
tag = ID3(sys.argv[1])
tag.add(USLT(encoding=3, lang='fre', desc='', text='paroles francaises'))
tag.save(sys.argv[1], v2_version=3, v1=0)
tag_helper.write_metadata(sys.argv[1], {'lyrics': 'new plain lyrics'})
after = ID3(sys.argv[1]).getall('USLT')
results['genuine-other-language'] = {'count': len(after), 'langs': sorted(str(f.lang) for f in after)}

print(json.dumps(results))
`;
  try {
    const result = spawnSync('python3', ['-c', script, mp3], { cwd: path.resolve(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim());
    for (const lang of ["'   '", "'XXX'", "'\\x00\\x00\\x00'", "'eng'", "'und'"]) {
      assert.equal(out[lang].count, 1, `lang ${lang} must result in exactly one USLT frame, not a stale duplicate`);
      assert.equal(out[lang].text, 'new plain lyrics', `lang ${lang} must be replaced with the new text, not left as old synced garbage`);
    }
    assert.equal(out['genuine-other-language'].count, 2, 'a real, different language frame must be preserved as its own separate frame, not deleted');
    assert.deepEqual(out['genuine-other-language'].langs, ['eng', 'fre']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
