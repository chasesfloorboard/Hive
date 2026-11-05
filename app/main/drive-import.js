'use strict';

// Importing music from Google Drive: a folder (or one file) shared as
// "Anyone with the link". Its songs are downloaded into the music folder under
// the Drive folder's name, subfolders kept, and the window makes them a
// playlist in Drive's order. Nothing needs a Google account: folders are read
// from Drive's public folder view, files from its download address.

const fs = require('node:fs');
const path = require('node:path');

const AUDIO = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aiff', 'aif', 'wma', 'alac', 'ape', 'wv']);
const ID = '[A-Za-z0-9_-]{10,}';

/** What a pasted link points at: { kind: 'folder' | 'file', id }, or null. */
function parseDriveLink(text) {
  const s = String(text || '').trim();
  let m = new RegExp(`/folders/(${ID})`).exec(s);
  if (m) return { kind: 'folder', id: m[1] };
  m = new RegExp(`/file/d/(${ID})`).exec(s);
  if (m) return { kind: 'file', id: m[1] };
  m = new RegExp(`[?&]id=(${ID})`).exec(s);
  if (m && /drive\.google\.com|docs\.google\.com|drive\.usercontent\.google\.com/.test(s)) return { kind: /\/(open|drive)\b/.test(s) && !/\/(uc|download)\b/.test(s) ? 'unknown' : 'file', id: m[1] };
  return null;
}

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** A public folder view page: its title, files and subfolders (in Drive's order). */
function parseFolderPage(html) {
  const page = String(html || '');
  const title = decode((/<title>([^<]*)<\/title>/.exec(page) || [])[1] || '').trim();
  const files = [], folders = [];
  const entry = /<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?class="flip-entry-title">([^<]*)</g;
  let m;
  while ((m = entry.exec(page))) {
    const [, id, href, name] = m;
    const item = { id, name: decode(name).trim() };
    if (/\/folders\//.test(href)) folders.push(item); else files.push(item);
  }
  return { title, files, folders };
}

const extOf = name => String(name || '').split('.').pop().toLowerCase();
const isAudio = name => AUDIO.has(extOf(name));
const safe = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/\.+$/, '').slice(0, 120) || 'Untitled';
const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function createDriveImport({ fetch, log = () => {} }) {
  async function folder(id) {
    const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, { headers: { 'Accept-Language': 'en' } });
    if (res.status === 404 || res.status === 403) throw new Error("That Google Drive folder isn't shared. Set it to “Anyone with the link” in Drive, then try again.");
    if (!res.ok) throw new Error(`Google Drive answered ${res.status}`);
    const page = parseFolderPage(await res.text());
    if (!page.title && !page.files.length && !page.folders.length) throw new Error("That Google Drive folder isn't shared, or it's empty. Set it to “Anyone with the link”, then try again.");
    return page;
  }

  /**
   * Every song in a folder and its subfolders (three levels down), in order:
   * [{ id, name, dir }], dir being the subfolder path inside the import.
   */
  async function list(link) {
    const at = parseDriveLink(link);
    if (!at) throw new Error('Paste a Google Drive link to a folder or a file.');
    if (at.kind === 'file') return { title: '', songs: [{ id: at.id, name: '', dir: '' }] };
    const top = await folder(at.id).catch(err => { if (at.kind === 'unknown') return null; throw err; });
    if (!top) return { title: '', songs: [{ id: at.id, name: '', dir: '' }] };
    const songs = [];
    const walk = async (page, dir, depth) => {
      for (const f of [...page.files].sort(natural)) if (isAudio(f.name)) songs.push({ id: f.id, name: f.name, dir });
      if (depth >= 3) return;
      for (const sub of [...page.folders].sort(natural)) {
        try { await walk(await folder(sub.id), path.join(dir, safe(sub.name)), depth + 1); } catch (err) { log(`Subfolder ${sub.name}: ${err.message}`); }
      }
    };
    await walk(top, '', 0);
    return { title: top.title || 'Google Drive', songs };
  }

  /** Saves one song into [dir] (its Drive name; a single file's name comes from Drive). Skips a copy already there. */
  async function download(song, dir, onBytes = () => {}) {
    const res = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(song.id)}&export=download&confirm=t`);
    if (!res.ok) throw new Error(res.status === 404 ? 'not shared, or gone' : `Google Drive answered ${res.status}`);
    // Drive answers with a web page instead of the file when it's limiting downloads of it.
    const type = String(res.headers.get('content-type') || '');
    if (/text\/html/.test(type)) throw new Error('Google Drive is limiting downloads of this file right now; try again later');
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(res.headers.get('content-disposition') || ''));
    const name = song.name || (fromHeader ? decodeURIComponent(fromHeader[1]) : `${song.id}.mp3`);
    if (!isAudio(name)) throw new Error(`${name} isn't a song`);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, safe(name.replace(/\.[^.]+$/, '')) + '.' + extOf(name));
    const size = Number(res.headers.get('content-length')) || 0;
    try { if (size && fs.statSync(target).size === size) { await res.body?.cancel?.(); return target; } } catch {}
    const part = `${target}.part`;
    const out = fs.createWriteStream(part);
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        onBytes(got, size);
      }
      await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
      if (size && got !== size) throw new Error(`stopped at ${got} of ${size} bytes`);
      fs.renameSync(part, target);
    } catch (err) {
      out.destroy();
      try { fs.rmSync(part, { force: true }); } catch {}
      throw err;
    }
    return target;
  }

  /**
   * The whole import: lists the link, then downloads each song into
   * <musicFolder>/<folder name>/. progress({ done, total, name }) after each.
   * Returns { title, paths (in order), failed: [names] }.
   */
  async function importLink(link, musicFolder, progress = () => {}) {
    const { title, songs } = await list(link);
    if (!songs.length) throw new Error('There are no songs in that Google Drive folder (MP3, FLAC, M4A, Ogg, WAV…).');
    const base = path.join(musicFolder, safe(title || 'Google Drive'));
    const paths = [], failed = [];
    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      progress({ done: i, total: songs.length, name: s.name });
      try { paths.push(await download(s, path.join(base, s.dir))); }
      catch (err) { failed.push(s.name || s.id); log(`${s.name || s.id}: ${err.message}`); }
    }
    progress({ done: songs.length, total: songs.length, name: '' });
    const name = title || (paths[0] ? path.basename(paths[0]).replace(/\.[^.]+$/, '') : 'Google Drive');
    return { title: name, paths, failed };
  }

  return { list, download, importLink };
}

module.exports = { createDriveImport, parseDriveLink, parseFolderPage, isAudio };
