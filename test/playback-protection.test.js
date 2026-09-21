const assert = require('assert');
const { PlaybackProtection } = require('../app/main/playback-protection');

async function run() {
  const gate = new PlaybackProtection();
  gate.protect('/music/track.flac');

  let released = false;
  const waiting = gate.waitForRelease('/music/track.flac').then(() => { released = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(released, false, 'metadata must remain blocked while the active path is protected');

  gate.release('/music/track.flac');
  await waiting;
  assert.strictEqual(released, true, 'metadata waiter must resume immediately when playback releases the path');

  gate.protect('/music/playing.flac');
  let stillWaiting = true;
  const second = gate.waitForRelease('/music/playing.flac').then(() => { stillWaiting = false; });
  gate.release('/music/other.flac');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(stillWaiting, true, 'releasing another path must not release the protected track');
  gate.release('/music/playing.flac');
  await second;
  assert.strictEqual(stillWaiting, false, 'the protected path must release its metadata waiter');

  gate.protect('/music/multi.flac');
  let firstReleased = false;
  let secondReleased = false;
  const firstWaiter = gate.waitForRelease('/music/multi.flac').then(() => { firstReleased = true; });
  const secondWaiter = gate.waitForRelease('/music/multi.flac').then(() => { secondReleased = true; });
  gate.release('/music/multi.flac');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.strictEqual(firstReleased, true, 'all metadata waiters for a path must release');
  assert.strictEqual(secondReleased, true, 'a second metadata waiter must not be lost');
  void firstWaiter; void secondWaiter;

  gate.protect('/music/handoff-old.flac');
  let handedOff = false;
  const handoffWaiter = gate.waitForRelease('/music/handoff-old.flac').then(() => { handedOff = true; });
  gate.protect('/music/handoff-new.flac');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.strictEqual(handedOff, true, 'changing the protected playback path must release metadata for the old path');
  void handoffWaiter;
}

run().catch(err => { console.error(err); process.exitCode = 1; });
