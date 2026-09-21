const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const helper = fs.readFileSync(path.join(root, 'resources/python/tag_helper.py'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
// Rating and general-metadata writers were extracted into their own
// dependency-injected module; source-pattern checks for them read this file.
const metadataWriter = fs.readFileSync(path.join(root, 'app/main/metadata-writer.js'), 'utf8');
const canon = fs.readFileSync(path.join(root, 'docs/ai/HIVE-METADATA-BACKEND-CANON.md'), 'utf8');
const endgame = fs.readFileSync(path.join(root, 'docs/ai/HIVE-ENDGAME-DEVELOPMENT-PROMPT.md'), 'utf8');
const metadataWorker = fs.readFileSync(path.join(root, 'app/workers/metadata-worker.js'), 'utf8');

test('metadata backend canon exists and is referenced by end-game documentation', () => {
  assert.match(canon, /Status: CANONICAL/);
  assert.match(canon, /Mutagen/);
  assert.match(canon, /single-writer rule/i);
  assert.match(canon, /recovery backup/i);
  assert.match(endgame, /HIVE-METADATA-BACKEND-CANON\.md/);
});

test('metadata helper ships its own Mutagen backend for portable installs', () => {
  const bundled = path.join(root, 'resources', 'mutagen', '__init__.py');
  assert.ok(fs.existsSync(bundled), 'resources/mutagen must be bundled; metadata editing cannot depend on a system Python package');
  const result = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-S', '-c', [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(root, 'resources'))})`,
    'import mutagen',
    'print(mutagen.__file__)',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(path.resolve(result.stdout.trim()), path.resolve(bundled));
});

test('rating and Love writes use the bundled metadata backend', () => {
  assert.match(helper, /op=='write_rating'/);
  assert.match(helper, /op=='write_love'/);
  assert.match(helper, /def write_rating\(/);
  assert.match(helper, /def write_love\(/);
  const rating = metadataWriter.match(/async function embedRatingInFile\(trackPath, stars\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  const love = main.match(/async function embedLoveInFile\(trackPath, loved\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(rating, /op:'write_rating'/);
  assert.match(love, /op:'write_love'/);
  assert.doesNotMatch(rating, /runFfmpeg|runMetaflac|writeMp4RatingTag/);
  assert.doesNotMatch(love, /runFfmpeg|runMetaflac|writeMp4LoveTag/);
});

test('FLAC and generic-format Love writes in the background worker use the bundled backend, not metaflac/ffmpeg', () => {
  // MP3/WAV/M4A keep their own hand-rolled atom-surgery writers here (not a
  // canon violation, not touched by this test); FLAC and every other format
  // used to shell out to the external metaflac/ffmpeg binaries, which errors
  // outright on any system missing those separate packages. Both now route
  // through the same bundled Mutagen backend as every other writer.
  assert.doesNotMatch(metadataWorker, /spawn\(['"]metaflac['"]/);
  assert.doesNotMatch(metadataWorker, /spawn\(['"]ffmpeg['"]/);
  assert.match(metadataWorker, /runTagHelperOnce\(\{ op: 'write_love'/);
});

test('ordinary metadata verification stays inside the bundled Mutagen backend', () => {
  assert.match(helper, /def read_metadata_fields\(path, fields\)/);
  assert.match(helper, /op=='read_metadata_fields'/);
  const writerStart = metadataWriter.indexOf('async function performWriteMetadata(');
  const writerEnd = metadataWriter.indexOf('async function performWriteTags(', writerStart);
  const writer = metadataWriter.slice(writerStart, writerEnd);
  assert.match(writer, /op: 'read_metadata_fields'/);
  assert.doesNotMatch(writer, /ensureMM\(\)|parseFile\(/);
});

test('metadata writes retain staged recovery commit', () => {
  assert.match(main, /backupFileBeforeMetadataCommit/);
  assert.match(main, /commitMetadataTemp\(temp, trackPath/);
});

test('metadata recovery starts a fresh retry session and can recognize a completed write', () => {
  const recoveryBlock = main.slice(main.indexOf("if (Array.isArray(recoveredMetadataJobs)"), main.indexOf("app.on('activate'"));
  assert.match(recoveryBlock, /recoveredMetadataJobs\.map[\s\S]*attempts:0/);
  assert.match(recoveryBlock, /lastError:''/);

  const satisfactionStart = main.indexOf('async function metadataJobAlreadySatisfied(job)');
  const satisfactionEnd = main.indexOf('\nfunction enqueueMetadataSave', satisfactionStart);
  const satisfaction = main.slice(satisfactionStart, satisfactionEnd);
  assert.match(satisfaction, /job\.kind === 'metadata'/);
  assert.match(satisfaction, /op:'read_metadata_fields'/);
  assert.match(satisfaction, /op:'read_compilation'/);
  assert.match(satisfaction, /job\.artwork\?\.action/);
});

test('bundled MP4 backend round-trips Unicode freeform field names', () => {
  const script = String.raw`
import sys
sys.path.insert(0, '..')
from mutagen.mp4 import MP4Tags, _key2name
keys = ['----:com.apple.iTunes:🔊', '----:com.apple.iTunes:étiquette', '----:com.apple.iTunes:普通话']
for key in keys:
    tags = MP4Tags()
    tags[key] = [b'hello']
    rendered = tags._MP4Tags__render_freeform(key, [b'hello'])
    expected = key.split(':', 2)[2].encode('utf-8')
    assert expected in rendered, (key, rendered)
    assert _key2name(key).endswith(expected), (key, _key2name(key))
print('ok')
`;
  const result = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-c', script], {
    cwd: path.resolve(root, 'resources', 'python'), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'ok');
});

test('native rating reader matches namespaced MP4 freeform ids, not just bare ids', () => {
  // music-metadata returns MP4 freeform atoms as e.g.
  // "----:com.apple.iTunes:FMPS_Rating", never the bare "FMPS_RATING". The
  // FLAC/generic path compares a bare id, so without stripping the namespace
  // prefix a rating Hive itself wrote to an M4A file was silently unreadable
  // (write succeeded; only display read-back was broken).
  const start = main.indexOf('async function readNativeEmbeddedRating');
  const end = main.indexOf('\n}', start);
  const block = main.slice(start, end);
  assert.match(block, /rawId\.slice\(rawId\.lastIndexOf\(':'\)\s*\+\s*1\)/);
});

test('rating written to an M4A file by the bundled backend round-trips through the native reader\'s id-matching rule', async () => {
  // No M4A fixture is checked into the repo, and ffmpeg is not guaranteed to
  // be present in every environment this suite runs in (it has been absent
  // from sandboxed sessions before). Synthesize a tiny silent M4A with
  // ffmpeg when available; skip cleanly otherwise rather than failing the
  // whole suite over an environment gap.
  const which = require('child_process').spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (which.status !== 0) { return; }

  const os = require('os');
  const tmp = path.join(os.tmpdir(), `hive-rating-roundtrip-${Date.now()}.m4a`);
  const gen = require('child_process').spawnSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.2',
    '-c:a', 'aac', '-y', tmp
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr || gen.stdout);

  try {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources'))})
from python.tag_helper import write_rating
write_rating(${JSON.stringify(tmp)}, 3.5)
`;
    const py = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-c', script], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr || py.stdout);

    const mm = await import('music-metadata'); // ESM-only, same as main.js's ensureMM()
    await mm.parseFile(tmp, { duration: false, skipCovers: true }).then(meta => {
      let rating = 0;
      for (const tagList of Object.values(meta.native || {})) {
        for (const tag of (Array.isArray(tagList) ? tagList : [])) {
          const rawId = String(tag?.id || '');
          const id = (rawId.includes(':') ? rawId.slice(rawId.lastIndexOf(':') + 1) : rawId).toUpperCase();
          if (id === 'FMPS_RATING') {
            const n = Number(String(tag?.value?.text ?? tag?.value).replace(/[^0-9.+-]/g, ''));
            if (Number.isFinite(n)) rating = Math.max(rating, Math.max(0, Math.min(5, Math.round(n * 10) / 2)));
          }
        }
      }
      assert.equal(rating, 3.5);
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('scanner worker also matches namespaced MP4 freeform ids for rating, not just bare ids', () => {
  // scanner-worker.js independently computes the "rating" field the library
  // grid displays (main.js's readNativeEmbeddedRating is a separate on-demand
  // reader). It already derives idTail for the Love check on the line above
  // but was comparing the un-stripped id for FMPS_RATING, so a full library
  // scan/rescan would overwrite a just-written M4A rating back to 0 -- the
  // write succeeded but the visible star rating reverted on the next scan.
  const scanner = fs.readFileSync(path.join(root, 'app', 'workers', 'scanner-worker.js'), 'utf8');
  const start = scanner.indexOf("ext === '.m4a'");
  const end = scanner.indexOf('\n  }', start);
  const block = scanner.slice(start, end);
  assert.match(block, /idTail === 'FMPS_RATING'/);
  assert.doesNotMatch(block, /\bid === 'FMPS_RATING'/);
});

test('write_metadata and write_tags write real ID3 frames on WAV files instead of raising "not a Frame instance"', () => {
  // WAV's Mutagen tags object (the "id3 " RIFF chunk) is a real ID3Tags
  // instance, same as a bare .mp3 -- unlike write_metadata/write_tags'
  // generic fallback for OGG/AIFF-style plain dict-of-strings containers,
  // it needs proper Frame objects. A user hit this live: editing a WAV
  // track's title/year crashed with "'Low Rider' not a Frame instance".
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `hive-wav-metadata-${Date.now()}.wav`);
  const script = `
import sys, wave
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources'))})
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources', 'python'))})
w = wave.open(${JSON.stringify(tmp)}, 'wb')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
w.writeframes(b'\\x00\\x00' * 100)
w.close()
from tag_helper import write_metadata, write_tags
write_metadata(${JSON.stringify(tmp)}, {'title': 'Low Rider', 'year': '2026'}, None)
write_tags(${JSON.stringify(tmp)}, {'artist': 'War'})
from mutagen.wave import WAVE
f = WAVE(${JSON.stringify(tmp)})
assert str(f.tags.get('TIT2')) == 'Low Rider', f.tags.get('TIT2')
assert str(f.tags.get('TPE1')) == 'War', f.tags.get('TPE1')
print('ok')
`;
  try {
    const result = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'ok');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('scanner worker rating for an M4A file survives a real scan after the bundled backend writes it', async () => {
  const which = require('child_process').spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (which.status !== 0) { return; }

  const os = require('os');
  const tmp = path.join(os.tmpdir(), `hive-scanner-rating-${Date.now()}.m4a`);
  const gen = require('child_process').spawnSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.2',
    '-c:a', 'aac', '-y', tmp
  ], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr || gen.stdout);

  try {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources'))})
from python.tag_helper import write_rating
write_rating(${JSON.stringify(tmp)}, 5)
`;
    const py = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-c', script], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr || py.stdout);

    const { fork } = require('child_process');
    const workerPath = path.join(root, 'app', 'workers', 'scanner-worker.js');
    const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const track = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('scanner worker timed out')); }, 10000);
      child.on('message', msg => {
        if (msg?.id !== 1) return;
        clearTimeout(timer);
        child.kill();
        if (msg.type === 'result') resolve(msg.track);
        else reject(new Error(msg.error || 'scanner worker failed'));
      });
      child.send({ type: 'scan', id: 1, filePath: tmp, coversDir: os.tmpdir() });
    });
    assert.equal(track.rating, 5);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('plain_from_lrc strips both bracket and angle-bracket timestamp formats before embedding, not just [mm:ss.xx]', () => {
  // Real bug: the previous regex only matched [mm:ss.xx]/[mm:ss:xx]. A line
  // using any other real-world LRC variant (enhanced/word-level <mm:ss.xx>
  // karaoke tags, or a comma fraction separator) silently passed through
  // UNCHANGED -- since this is exactly what USLT (the "standard" embedded
  // lyrics tag) is written from, raw synced text with visible timestamps
  // could end up embedded as a file's "plain" lyrics, not just mis-shown in
  // the UI.
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources', 'python'))})
from tag_helper import plain_from_lrc
cases = [
    "[00:12.34]Standard bracket line",
    "[00:12,34]Comma fraction separator",
    "<00:12.34>Word-level line <00:13.10>with inline <00:13.50>karaoke tags",
    "[1:02:03.45]Hour-prefixed timestamp",
    "No timestamp at all",
]
for case in cases:
    result = plain_from_lrc(case)
    assert '[' not in result and ']' not in result and '<' not in result and '>' not in result, (case, result)
print('|'.join(plain_from_lrc(c) for c in cases))
`;
  const result = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.trim().split('|');
  assert.equal(lines[0], 'Standard bracket line');
  assert.equal(lines[1], 'Comma fraction separator');
  assert.equal(lines[2], 'Word-level line with inline karaoke tags');
  assert.equal(lines[3], 'Hour-prefixed timestamp');
  assert.equal(lines[4], 'No timestamp at all');
});

test('removing just the front cover from a file with both Front and Back covers actually reports success', () => {
  // Real bug, reproduced live: read_artwork's "treat the first picture as
  // Front when nothing is explicitly Front-typed" fallback (for old files
  // with a single generic/untyped picture) used to fire unconditionally --
  // including when the remaining picture had a genuine, explicit non-Front
  // type. Removing the front cover from a file with both Front and Back
  // covers correctly deleted the Front picture on disk, but the leftover
  // real Back cover then got relabeled "Cover (Front)" by this heuristic,
  // which made performRemoveFrontArtwork's own verification (checks whether
  // anything is still Front-typed) conclude the removal had FAILED and
  // report an error to the user, even though it had actually succeeded.
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `hive-artwork-front-back-${Date.now()}.mp3`);
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources'))})
sys.path.insert(0, ${JSON.stringify(path.resolve(root, 'resources', 'python'))})
from mutagen.id3 import ID3
from tag_helper import modify_artwork, remove_front, read_artwork_metadata

# Minimal valid MP3 frame so mutagen can open/save it.
with open(${JSON.stringify(tmp)}, 'wb') as f:
    f.write(b'\\xff\\xfb\\x90\\x00' + b'\\x00' * 200)
ID3().save(${JSON.stringify(tmp)}, v2_version=4, v1=0)

import os as _os
front_jpg = _os.path.join(_os.path.dirname(${JSON.stringify(tmp)}), 'front-test.jpg')
back_jpg = _os.path.join(_os.path.dirname(${JSON.stringify(tmp)}), 'back-test.jpg')
# Two genuinely different byte payloads -- modify_artwork's 'add' action
# dedupes by content hash, so identical bytes for front/back (an earlier
# version of this test reused the same file for both) silently skips the
# second add instead of actually adding a distinct picture.
with open(front_jpg, 'wb') as f: f.write(b'\\xff\\xd8\\xff\\xe0FRONT' + b'\\x01' * 100)
with open(back_jpg, 'wb') as f: f.write(b'\\xff\\xd8\\xff\\xe0BACK' + b'\\x02' * 100)

modify_artwork(${JSON.stringify(tmp)}, {'action': 'add', 'imagePath': front_jpg, 'pictureType': 'Cover (Front)', 'comment': ''})
modify_artwork(${JSON.stringify(tmp)}, {'action': 'add', 'imagePath': back_jpg, 'pictureType': 'Cover (Back)', 'comment': 'back'})
before = read_artwork_metadata(${JSON.stringify(tmp)})
assert sorted(p['type'] for p in before) == ['Cover (Back)', 'Cover (Front)'], before

remove_front(${JSON.stringify(tmp)})
after = read_artwork_metadata(${JSON.stringify(tmp)})
types = [p['type'] for p in after]
_os.unlink(front_jpg)
_os.unlink(back_jpg)
assert types == ['Cover (Back)'], f'expected only Cover (Back) to remain, got {types}'
print('ok')
`;
  try {
    const result = require('child_process').spawnSync(process.env.BEEHIVE_PYTHON || 'python3', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'ok');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
