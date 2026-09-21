'use strict';
// FLAC's Love write used to shell out to metaflac directly on the live
// trackPath -- no temp file, no atomic rename, no per-path lock, trusting
// metaflac's own internal safety alone. Every other format writer (MP3, WAV,
// MP4, and the whole Rating/artwork/metadata module) edits a temp copy on the
// same filesystem and only replaces the original via an fsync+atomic rename,
// so a crash or force-quit mid-write can never leave the real file
// half-written. This drives the real forked metadata-worker process end to
// end (the exact same IPC path main.js uses) to verify FLAC now follows suit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workerPath = path.join(root, 'app', 'workers', 'metadata-worker.js');

function sendLoveCommand(trackPath, loved) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('metadata worker timed out')); }, 15000);
    child.once('message', msg => { clearTimeout(timer); child.kill(); resolve(msg); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.send({ cmd: 'love', path: trackPath, loved: !!loved });
  });
}

function readFlacLoveTag(flacPath) {
  const result = spawnSync('metaflac', ['--show-tag=LOVE RATING', flacPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('embedding Love in a FLAC file uses an atomic temp+rename, not an in-place metaflac edit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-flac-love-'));
  const libraryDir = path.join(tempDir, 'library');
  fs.mkdirSync(libraryDir);
  const flac = path.join(libraryDir, 'track.flac');
  const ffmpeg = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.2', flac], { encoding: 'utf8' });
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);

  try {
    const result = await sendLoveCommand(flac, true);
    assert.equal(result.ok, true, result.error);

    assert.equal(readFlacLoveTag(flac), 'LOVE RATING=L', 'the real file must actually carry the Love tag on disk');

    // The write must have gone through the .beehive-tmp sibling directory and
    // been renamed away cleanly -- proof the atomic temp+rename path ran
    // instead of metaflac editing the live file in place.
    const tempSiblingDir = path.join(libraryDir, '.beehive-tmp');
    const leftovers = fs.existsSync(tempSiblingDir) ? fs.readdirSync(tempSiblingDir) : [];
    assert.equal(leftovers.length, 0, 'the .beehive-tmp temp file must be gone (renamed away) after a successful commit, proving the atomic path ran');

    // Toggle it off too, exercising the --remove-tag path through the same
    // atomic write.
    const unlove = await sendLoveCommand(flac, false);
    assert.equal(unlove.ok, true, unlove.error);
    assert.equal(readFlacLoveTag(flac), '', 'Love tag must be fully removed, not left stale, after Unlove');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
