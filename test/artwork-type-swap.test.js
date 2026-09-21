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
