'use strict';
// Real, direct exercises of app/main/metadata-writer.js -- the module rating,
// artwork, and general tag-editor writes were extracted into so this logic
// could be unit tested directly instead of only checked by grepping main.js's
// source text for the right patterns. See love-playback-safety.test.js,
// build256-metadata-safety.test.js, and build258-metadata-backend-canon.test.js
// for the source-pattern coverage of the same contract across every writer;
// this file is the behavioral coverage for one representative writer
// (embedRatingInFile) plus the two pieces every writer shares
// (withMusicBeeWriteLock, createMetadataTempPath).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createMetadataWriter } = require('../app/main/metadata-writer');

const root = path.resolve(__dirname, '..');
const pythonDir = path.join(root, 'resources', 'python');
const resourcesDir = path.join(root, 'resources');
const PYTHON = process.env.BEEHIVE_PYTHON || 'python3';

// A faithful (if minimal) stand-in for main.js's real runTagHelper: spawns the
// same persistent tag_helper.py worker process and speaks its actual
// JSON-line request/response protocol, so writes in this test go through the
// real bundled Mutagen backend, not a fake.
function startTagHelperWorker() {
  const proc = spawn(PYTHON, ['tag_helper.py'], { cwd: pythonDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error));
    }
  });
  let seq = 0;
  function runTagHelper(request) {
    const id = String(++seq);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ ...request, id }) + '\n');
    });
  }
  return { runTagHelper, stop: () => { try { proc.kill(); } catch {} } };
}

function readPopmByte(mp3Path) {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(resourcesDir)})
from mutagen.id3 import ID3
tag = ID3(sys.argv[1])
frames = tag.getall('POPM')
print(frames[0].rating if frames else -1)
`;
  const result = spawnSync(PYTHON, ['-c', script, mp3Path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return Number(result.stdout.trim());
}

function makeStubWriter(overrides = {}) {
  return createMetadataWriter({
    runTagHelper: async () => ({}),
    copyMetadataFile: async (src, dest) => fsp.copyFile(src, dest),
    markLibraryInternalWrite: () => {},
    waitForPlaybackProtectionRelease: async () => {},
    normalizePictureType: v => v,
    readEmbeddedRating: async () => 0,
    tagBackupsDir: () => '/tmp',
    ...overrides,
  });
}

test('embedRatingInFile writes an atomic, backed-up, lock-protected rating end to end', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-metadata-writer-'));
  const libraryDir = path.join(tempDir, 'library');
  fs.mkdirSync(libraryDir);
  const mp3 = path.join(libraryDir, 'track.mp3');
  const initScript = `
import sys
sys.path.insert(0, ${JSON.stringify(resourcesDir)})
from mutagen.id3 import ID3
ID3().save(sys.argv[1], v2_version=3, v1=0)
`;
  const init = spawnSync(PYTHON, ['-c', initScript, mp3], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const worker = startTagHelperWorker();
  const waited = [];
  // readEmbeddedRating is deliberately stubbed: it is main.js's own POPM
  // reader (music-metadata/native parsing), not part of what was extracted
  // into this module, so it is out of scope here. What this test actually
  // verifies -- that the real file on disk ends up rated -- is checked
  // independently below via readPopmByte, not through this stub.
  const writer = makeStubWriter({
    runTagHelper: worker.runTagHelper,
    waitForPlaybackProtectionRelease: async (p) => { waited.push(p); },
    readEmbeddedRating: async () => 5,
    tagBackupsDir: () => path.join(tempDir, 'backups'),
  });

  try {
    await writer.embedRatingInFile(mp3, 5);

    assert.equal(readPopmByte(mp3), 255, 'the real file must actually be rated 5 stars (POPM 255) on disk');
    assert.ok(waited.includes(path.resolve(mp3)), 'must wait for playback protection release before writing');

    const backupsDir = path.join(tempDir, 'backups');
    assert.ok(fs.existsSync(backupsDir), 'must create a recovery backup directory before committing');
    const backups = fs.readdirSync(backupsDir);
    assert.ok(backups.some(f => f.endsWith('.mp3')), 'a pre-write backup copy of the original file must exist');
    assert.ok(backups.some(f => f.endsWith('manifest.json')), 'a backup manifest must be recorded');

    const tempSiblingDir = path.join(libraryDir, '.beehive-tmp');
    const leftovers = fs.existsSync(tempSiblingDir) ? fs.readdirSync(tempSiblingDir) : [];
    assert.equal(leftovers.length, 0, 'the .beehive-tmp temp file must be gone (renamed away) after a successful commit');
  } finally {
    worker.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('embedRatingInFile leaves the original file untouched when write verification fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-metadata-writer-fail-'));
  const mp3 = path.join(tempDir, 'track.mp3');
  const initScript = `
import sys
sys.path.insert(0, ${JSON.stringify(resourcesDir)})
from mutagen.id3 import ID3
ID3().save(sys.argv[1], v2_version=3, v1=0)
`;
  spawnSync(PYTHON, ['-c', initScript, mp3], { encoding: 'utf8' });
  const originalBytes = fs.readFileSync(mp3);

  const worker = startTagHelperWorker();
  // A readEmbeddedRating that never matches simulates a verification failure
  // (e.g. a corrupt write) -- the original file must survive untouched.
  const writer = makeStubWriter({
    runTagHelper: worker.runTagHelper,
    readEmbeddedRating: async () => 0,
    tagBackupsDir: () => path.join(tempDir, 'backups'),
  });

  try {
    await assert.rejects(() => writer.embedRatingInFile(mp3, 5), /Rating write verification failed/);
    assert.deepEqual(fs.readFileSync(mp3), originalBytes, 'the original file must be byte-for-byte untouched after a failed write');
    assert.ok(!fs.existsSync(path.join(tempDir, 'backups')), 'no backup should be made when the write never reaches commit');
  } finally {
    worker.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Recording that a write happened (persistMetadataJob) is only half of crash
// safety -- the other half is that the backup commitMetadataTemp makes
// before every rename is a genuinely restorable copy of the pre-write file,
// since that backup is exactly what a real restore (manual, or a future
// recovery-tool feature) would copy back over the track. This simulates that
// restore directly: write a rating, then verify copying the backup over the
// (now-changed) file actually reproduces the untouched original byte for
// byte, not just that a file happens to exist in the backups directory.
test('the pre-write backup a rating write creates is a byte-exact, genuinely restorable copy of the original', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-metadata-writer-restore-'));
  const libraryDir = path.join(tempDir, 'library');
  fs.mkdirSync(libraryDir);
  const mp3 = path.join(libraryDir, 'track.mp3');
  const initScript = `
import sys
sys.path.insert(0, ${JSON.stringify(resourcesDir)})
from mutagen.id3 import ID3, TIT2
tag = ID3()
tag.add(TIT2(encoding=3, text=['Original Title']))
tag.save(sys.argv[1], v2_version=3, v1=0)
`;
  const init = spawnSync(PYTHON, ['-c', initScript, mp3], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const originalBytes = fs.readFileSync(mp3);
  const originalSha256 = require('crypto').createHash('sha256').update(originalBytes).digest('hex');

  const worker = startTagHelperWorker();
  const backupsDir = path.join(tempDir, 'backups');
  const writer = makeStubWriter({
    runTagHelper: worker.runTagHelper,
    readEmbeddedRating: async () => 5,
    tagBackupsDir: () => backupsDir,
  });

  try {
    await writer.embedRatingInFile(mp3, 5);
    // The live file must now differ (it was actually rated) -- otherwise
    // "restoring" it below would trivially match for the wrong reason.
    assert.notDeepEqual(fs.readFileSync(mp3), originalBytes, 'the file must actually have changed after the rating write');

    const manifestFile = fs.readdirSync(backupsDir).find(f => f.endsWith('manifest.json'));
    assert.ok(manifestFile, 'a recovery manifest must exist');
    const manifest = JSON.parse(fs.readFileSync(path.join(backupsDir, manifestFile), 'utf8'));
    assert.equal(manifest.originalSha256, originalSha256, 'the manifest must record the true pre-write hash');
    assert.equal(manifest.originalPath, path.resolve(mp3));
    assert.ok(fs.existsSync(manifest.backupPath), 'the manifest must point at a backup file that actually exists');

    const backupBytes = fs.readFileSync(manifest.backupPath);
    assert.deepEqual(backupBytes, originalBytes, 'the backup file itself must be byte-identical to the pre-write original');

    // Simulate an actual restore: copy the backup back over the (now rated)
    // live file, exactly what a human or a recovery tool would do.
    fs.copyFileSync(manifest.backupPath, mp3);
    assert.deepEqual(fs.readFileSync(mp3), originalBytes, 'restoring from the backup must reproduce the untouched original exactly');
  } finally {
    worker.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('withMusicBeeWriteLock serializes concurrent writers for the same path', async () => {
  const writer = makeStubWriter();
  const order = [];
  const first = writer.withMusicBeeWriteLock('/music/a.mp3', async () => {
    order.push('first-start');
    await new Promise(r => setTimeout(r, 30));
    order.push('first-end');
    return 'first';
  });
  const second = writer.withMusicBeeWriteLock('/music/a.mp3', async () => {
    order.push('second-start');
    return 'second';
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ['first', 'second']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start'], 'the second writer must not start until the first has fully finished');
});

test('withMusicBeeWriteLock does not serialize writers for different paths', async () => {
  const writer = makeStubWriter();
  const order = [];
  const a = writer.withMusicBeeWriteLock('/music/a.mp3', async () => {
    order.push('a-start');
    await new Promise(r => setTimeout(r, 30));
    order.push('a-end');
  });
  const b = writer.withMusicBeeWriteLock('/music/b.mp3', async () => {
    order.push('b-start');
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-start', 'b-start', 'a-end'], 'an unrelated file must not wait behind a slow write to a different file');
});

test('createMetadataTempPath places temp files in a .beehive-tmp sibling directory on the target\'s own filesystem', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-metadata-writer-temp-'));
  const target = path.join(tempDir, 'track.flac');
  fs.writeFileSync(target, 'x');
  const writer = makeStubWriter({ tagBackupsDir: () => path.join(tempDir, 'backups') });
  try {
    const tempPath = await writer.createMetadataTempPath(target, 'rating');
    assert.equal(path.dirname(tempPath), path.join(tempDir, '.beehive-tmp'));
    assert.equal(path.extname(tempPath), '.flac');
    assert.match(path.basename(tempPath), /^media-\d+-\d+-rating-[0-9a-f]{16}\.flac$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// When the .beehive-tmp sibling directory can't be created (e.g. a read-only
// library mount), createMetadataTempPath falls back to an OS temp dir via the
// injected `osTempDir` dependency. This used to be `require('electron').app`
// called directly inside this module -- which resolves to a path STRING, not
// the {app, ...} object, in any context that isn't a real running Electron
// process (a plain Node test run included). That made this exact fallback
// throw a confusing "app.getPath is not a function" instead of falling back,
// and nothing caught it because no test forced this branch to actually run.
test('createMetadataTempPath falls back to the injected OS temp dir when the sibling directory cannot be created', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-metadata-writer-fallback-'));
  const target = path.join(tempDir, 'track.mp3');
  fs.writeFileSync(target, 'x');
  // Block the sibling directory by occupying its path with a plain file.
  fs.writeFileSync(path.join(tempDir, '.beehive-tmp'), 'blocking file, not a directory');
  const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-metadata-writer-osfallback-'));
  const writer = makeStubWriter({ osTempDir: () => fallbackDir });
  try {
    const tempPath = await writer.createMetadataTempPath(target, 'rating');
    assert.equal(path.dirname(tempPath), path.join(fallbackDir, 'beehive-metadata'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(fallbackDir, { recursive: true, force: true });
  }
});
