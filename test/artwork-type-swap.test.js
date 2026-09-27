const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

function startTagHelper() {
  const proc = spawn('python3', [path.join(__dirname, '..', 'resources', 'python', 'tag_helper.py')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = new Map();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || 'tag helper failed'));
    }
  });
  let nextId = 1;
  return {
    call(op, extra = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n');
      });
    },
    close() {
      proc.kill();
    }
  };
}

test('MP3 artwork front/back role swap persists and follows the new front cover', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-artwork-swap-'));
  const mediaPath = path.join(dir, 'swap.mp3');
  const imageScript = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'resources'))})
from mutagen.id3 import ID3, APIC
p = r'''${mediaPath.replace(/'/g, "\\'")}'''
id3 = ID3()
id3.add(APIC(encoding=3, mime='image/jpeg', type=3, desc='front', data=b'FRONT-IMAGE'))
id3.add(APIC(encoding=3, mime='image/jpeg', type=4, desc='back', data=b'BACK-IMAGE'))
id3.save(p, v2_version=3, v1=0)
`;
  const setup = spawn('python3', ['-c', imageScript], { stdio: ['ignore', 'ignore', 'pipe'] });
  const setupErr = [];
  setup.stderr.on('data', d => setupErr.push(String(d)));
  const setupExit = await new Promise(resolve => setup.on('close', code => resolve(code)));
  assert.equal(setupExit, 0, setupErr.join(''));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const helper = startTagHelper();
  t.after(() => helper.close());
  const initial = (await helper.call('read_artwork', { path: mediaPath })).pictures;
  assert.equal(initial.length, 2);

  const front = initial.find(p => p.dataBase64 === Buffer.from('FRONT-IMAGE').toString('base64'));
  const back = initial.find(p => p.dataBase64 === Buffer.from('BACK-IMAGE').toString('base64'));
  assert.equal(front.type, 'Cover (Front)');
  assert.equal(back.type, 'Cover (Back)');

  await helper.call('modify_artwork', {
    path: mediaPath,
    operation: { action: 'update', index: front.index, pictureType: 'Cover (Back)', comment: front.description }
  });
  const afterFirst = (await helper.call('read_artwork', { path: mediaPath })).pictures;
  const movedFront = afterFirst.find(p => p.dataBase64 === front.dataBase64);
  const movedBack = afterFirst.find(p => p.dataBase64 === back.dataBase64);
  await helper.call('modify_artwork', {
    path: mediaPath,
    operation: { action: 'update', index: movedBack.index, pictureType: 'Cover (Front)', comment: movedBack.description }
  });

  const final = (await helper.call('read_artwork', { path: mediaPath })).pictures;
  const finalFront = final.find(p => p.dataBase64 === front.dataBase64);
  const finalBack = final.find(p => p.dataBase64 === back.dataBase64);
  assert.equal(finalFront.type, 'Cover (Back)');
  assert.equal(finalBack.type, 'Cover (Front)');
});

// Album artwork arrangement: the same pictures in different slots/types per
// file are rewritten to one chosen order + types, reusing each file's own
// image bytes (matched by sha256). The order must survive a later unrelated
// save too: mutagen sorts ID3 frames by size, so MP3/WAV lost it until
// tag_helper patched the writer. The images differ in size on purpose.
test('artwork "arrange" rewrites FLAC/MP3/WAV to the chosen order and types, and a later save keeps it', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-arrange-'));
  try {
    const script = String.raw`
import json, sys, subprocess, hashlib
sys.path.insert(0, '..')
import tag_helper
d = sys.argv[1]
imgs = []
for i, (color, size) in enumerate([('red', 16), ('green', 32), ('blue', 64)]):
    p = f'{d}/c{i}.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'color=c={color}:s={size}x{size}', '-frames:v', '1', p], check=True)
    imgs.append(p)
H = [hashlib.sha256(open(p, 'rb').read()).hexdigest() for p in imgs]
out = {}
for ext in ('flac', 'mp3', 'wav'):
    f = f'{d}/t.{ext}'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '0.1', f], check=True)
    tag_helper.write_metadata(f, {}, {'action': 'add', 'imagePath': imgs[2], 'pictureType': 'Cover (Front)'})
    tag_helper.write_metadata(f, {}, {'action': 'add', 'imagePath': imgs[0], 'pictureType': 'Cover (Back)', 'comment': 'b'})
    tag_helper.write_metadata(f, {}, {'action': 'add', 'imagePath': imgs[1], 'pictureType': 'Other', 'comment': 'o'})
    tag_helper.write_metadata(f, {}, {'action': 'arrange', 'order': [{'hash': H[0], 'type': 'Cover (Front)'}, {'hash': H[2], 'type': 'Cover (Back)'}]})
    tag_helper.write_metadata(f, {'title': 'later save'}, None)
    out[ext] = [(p['sha256'], p['type']) for p in tag_helper.read_artwork_metadata(f)]
print(json.dumps({'H': H, 'out': out}))
`;
    const r = spawnSync('python3', ['-c', script, dir], { cwd: path.join(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const { H, out } = JSON.parse(r.stdout.trim().split('\n').pop());
    for (const ext of ['flac', 'mp3', 'wav']) {
      assert.deepEqual(out[ext], [[H[0], 'Cover (Front)'], [H[2], 'Cover (Back)'], [H[1], 'Other']], `${ext}: arranged pictures first, unmentioned ones kept after`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
