const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDriveImport, parseDriveLink, parseFolderPage } = require('../app/main/drive-import');

test('Google Drive links: folders, files and the older ?id= forms', () => {
  assert.deepEqual(parseDriveLink('https://drive.google.com/drive/folders/1dQ4sx0-__Nvg65rxTSgQrl7VyW_FZ9QI?usp=sharing'), { kind: 'folder', id: '1dQ4sx0-__Nvg65rxTSgQrl7VyW_FZ9QI' });
  assert.deepEqual(parseDriveLink('https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOp'), { kind: 'folder', id: '1AbCdEfGhIjKlMnOp' });
  assert.deepEqual(parseDriveLink('https://drive.google.com/file/d/1eE-5jm2G8N5FL4HHeexrL0-Lg15bc0-D/view'), { kind: 'file', id: '1eE-5jm2G8N5FL4HHeexrL0-Lg15bc0-D' });
  assert.deepEqual(parseDriveLink('https://drive.google.com/uc?id=1eE-5jm2G8N5FL4HHeexrL0&export=download'), { kind: 'file', id: '1eE-5jm2G8N5FL4HHeexrL0' });
  assert.equal(parseDriveLink('https://example.com/folders'), null);
});

// What Drive's public folder view looks like (trimmed from a real page).
const entry = (id, href, name) => `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${href}" target="_blank"><div class="flip-entry-list-icon"></div><div class="flip-entry-title">${name}</div></a></div></div>`;
const page = (title, entries) => `<html><head><title>${title}</title></head><body><div class="flip-entries">${entries.join('')}</div></body></html>`;

test('a public folder page gives its title, songs and subfolders', () => {
  const p = parseFolderPage(page('Road Trip &amp; More', [
    entry('f1', 'https://drive.google.com/file/d/f1/view?usp=drive_web', '02 Second.mp3'),
    entry('d1', 'https://drive.google.com/drive/folders/d1', 'Disc 2'),
    entry('f2', 'https://drive.google.com/file/d/f2/view?usp=drive_web', 'cover.jpg'),
  ]));
  assert.equal(p.title, 'Road Trip & More');
  assert.deepEqual(p.files.map(f => f.name), ['02 Second.mp3', 'cover.jpg']);
  assert.deepEqual(p.folders, [{ id: 'd1', name: 'Disc 2' }]);
});

test('importing a folder downloads its songs (subfolders too, in order) into <music>/<folder>/ and skips the rest', async () => {
  const music = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-drive-'));
  const pages = {
    topFolder123: page('Road Trip', [entry('f2', '/file/d/f2/view', '10 Ten.mp3'), entry('f1', '/file/d/f1/view', '2 Two.flac'), entry('img', '/file/d/img/view', 'cover.jpg'), entry('subFolder123', '/drive/folders/subFolder123', 'Disc 2')]),
    subFolder123: page('Disc 2', [entry('f3', '/file/d/f3/view', '1 One.m4a')]),
  };
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/embeddedfolderview') {
      const html = pages[u.searchParams.get('id')];
      return html ? { ok: true, status: 200, text: async () => html } : { ok: false, status: 404 };
    }
    const id = u.searchParams.get('id');
    if (id === 'f1') return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: null };
    const data = Buffer.from(`song ${id}`);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': String(data.length) }), body: (async function* () { yield data; })() };
  };
  try {
    const seen = [];
    const r = await createDriveImport({ fetch }).importLink('https://drive.google.com/drive/folders/topFolder123', music, p => seen.push(p.done));
    assert.equal(r.title, 'Road Trip');
    assert.deepEqual(r.paths.map(p => path.relative(music, p)), [path.join('Road Trip', '10 Ten.mp3'), path.join('Road Trip', 'Disc 2', '1 One.m4a')]);
    assert.deepEqual(r.failed, ['2 Two.flac'], 'Drive limiting a file is reported, not saved as a song');
    assert.equal(fs.readFileSync(r.paths[0], 'utf8'), 'song f2');
    assert.ok(!fs.existsSync(path.join(music, 'Road Trip', 'cover.jpg')));
    assert.ok(fs.readdirSync(path.join(music, 'Road Trip')).every(f => !f.endsWith('.part')));
    assert.deepEqual(seen, [0, 1, 2, 3]);
    await assert.rejects(createDriveImport({ fetch }).importLink('https://drive.google.com/drive/folders/privateFolder1', music), /Anyone with the link/);
  } finally { fs.rmSync(music, { recursive: true, force: true }); }
});
