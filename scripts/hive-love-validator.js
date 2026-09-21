#!/usr/bin/env node
'use strict';

/*
 * Hive Love metadata validator / manual normalizer.
 *
 * This utility is intentionally standalone: it uses only Node's standard
 * library for inspection and delegates approved writes to Hive's existing
 * format-aware metadata worker. It does NOT require node_modules.
 *
 * Default mode is read-only. With --interactive --apply, every file is
 * explicitly approved as Loved, Unloved, or Skip before it is modified.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { fork, spawn } = require('child_process');

const LOVE_FIELDS = new Set([
  'LOVE RATING',
  'LOVE',
  'LOVERATING',
  'MUSICBEE/LOVE RATING',
  'MUSICBEE/LOVERATING',
  'MUSICBEE LOVE RATING'
]);
const LOVE_VALUES = new Set(['L','Y','YES','TRUE','1','LOVE','LOVED','FAVORITE','FAVOURITE']);
const UNLOVE_VALUES = new Set(['0','U','N','NO','FALSE','UNLOVED']);
const AUDIO_EXTENSIONS = new Set([
  '.mp3','.flac','.wav','.m4a','.m4b','.mp4','.ogg','.oga','.opus','.aac',
  '.alac','.aiff','.aif','.ape','.wv','.mka','.webm'
]);
const WRITABLE_EXTENSIONS = new Set(['.mp3','.flac','.wav','.m4a','.m4b','.mp4']);

function usage() {
  console.log(`Usage: node scripts/hive-love-validator.js <music-directory> [options]

Options:
  --interactive       Review every file containing recognized Love metadata.
  --apply             Actually normalize approved files (requires --interactive).
  --report <file>     Write the audit as JSON (default: hive-love-audit-<timestamp>.json).
  --no-recursive      Only inspect the supplied directory, not subdirectories.
  --help              Show this help.

Interactive choices:
  l = Loved: remove every recognized Love alias and write exactly LOVE RATING=L
  u = Unloved: remove every recognized Love alias; absence is canonical Unloved
  s = Skip this file
  q = Quit without processing remaining files

The script is read-only unless BOTH --interactive and --apply are supplied.
Rating/POPM/FMPS metadata is intentionally not used to determine Love state.
No npm install or node_modules is required for the audit.`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { interactive:false, apply:false, recursive:true, report:'' };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--interactive') opts.interactive = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--no-recursive') opts.recursive = false;
    else if (arg === '--report') opts.report = args[++i] || '';
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  opts.root = positional[0] || '';
  return opts;
}

function normalizeField(value) { return String(value ?? '').trim().toUpperCase(); }
function normalizeValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (LOVE_VALUES.has(v)) return 'L';
  if (UNLOVE_VALUES.has(v)) return '0';
  return v;
}
function pushObservation(out, field, raw) {
  for (const piece of String(raw ?? '').split('\0')) {
    const clean = piece.trim();
    if (clean) out.push({ field: normalizeField(field), raw: clean, normalized: normalizeValue(clean) });
  }
}

function readId3Size(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}
function id3FrameSize(buf, version) {
  if (!buf || buf.length < 4) return -1;
  return version >= 4
    ? ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f)
    : buf.readUInt32BE(0);
}
function parseId3Frames(payload, version) {
  const frames = [];
  let pos = 0;
  while (pos + 10 <= payload.length) {
    const id = payload.toString('ascii', pos, pos + 4);
    if (/^\x00{4}$/.test(id)) {
      let next = pos;
      while (next < payload.length && payload[next] === 0) next++;
      if (next + 10 <= payload.length) {
        const nextId = payload.toString('ascii', next, next + 4);
        const nextSize = id3FrameSize(payload.subarray(next + 4, next + 8), version);
        if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
          pos = next;
          continue;
        }
      }
      break;
    }
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = id3FrameSize(payload.subarray(pos + 4, pos + 8), version);
    if (frameSize <= 0 || pos + 10 + frameSize > payload.length) break;
    frames.push({ id, data: payload.subarray(pos + 10, pos + 10 + frameSize) });
    pos += 10 + frameSize;
  }
  return frames;
}
function decodeId3Text(data) {
  if (!data || !data.length) return '';
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0) {
    const nul = body.indexOf(0);
    return body.subarray(0, nul >= 0 ? nul : body.length).toString('latin1').trim();
  }
  if (encoding === 3) {
    const nul = body.indexOf(0);
    return body.subarray(0, nul >= 0 ? nul : body.length).toString('utf8').trim();
  }
  if (encoding === 1 || encoding === 2) {
    let end = body.length;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
    }
    try { return body.subarray(0, end).toString('utf16le').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
  }
  return '';
}
function txxxParts(data) {
  if (!data || !data.length) return { description:'', value:'' };
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0 || encoding === 3) {
    const nul = body.indexOf(0);
    const desc = body.subarray(0, nul >= 0 ? nul : body.length).toString(encoding === 3 ? 'utf8' : 'latin1');
    const value = nul >= 0 ? body.subarray(nul + 1).toString(encoding === 3 ? 'utf8' : 'latin1') : '';
    return { description:desc.trim(), value:value.trim() };
  }
  if (encoding === 1 || encoding === 2) {
    let nul = -1;
    for (let i = 0; i + 1 < body.length; i += 2) if (body[i] === 0 && body[i + 1] === 0) { nul = i; break; }
    try {
      const descEnd = nul >= 0 ? nul : body.length;
      const desc = body.subarray(0, descEnd).toString('utf16le').replace(/^\uFEFF/, '').trim();
      const value = nul >= 0 ? body.subarray(nul + 2).toString('utf16le').replace(/^\uFEFF/, '').trim() : '';
      return { description:desc, value };
    } catch { return { description:'', value:'' }; }
  }
  return { description:'', value:'' };
}
function inspectId3Buffer(data, observations) {
  if (!data || data.length < 10 || data.toString('ascii', 0, 3) !== 'ID3') return false;
  const version = data[3] >= 4 ? 4 : 3;
  const payload = data.subarray(10, Math.min(data.length, 10 + readId3Size(data)));
  for (const frame of parseId3Frames(payload, version)) {
    if (frame.id !== 'TXXX') continue;
    const { description, value } = txxxParts(frame.data);
    if (LOVE_FIELDS.has(normalizeField(description))) pushObservation(observations, description, value);
  }
  return true;
}
async function readWavId3(filePath) {
  const input = await fsp.readFile(filePath);
  if (input.length < 12 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  while (pos + 8 <= input.length) {
    const id = input.toString('ascii', pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const start = pos + 8;
    const end = start + size;
    if (end > input.length) break;
    if ((id === 'id3 ' || id === 'ID3 ') && size >= 10 && input.toString('ascii', start, start + 3) === 'ID3') return input.subarray(start, end);
    pos = end + (size & 1);
  }
  return null;
}

function mp4Atom(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const size = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  if (size === 0) return { offset, size:buffer.length - offset, type, header:8, end:buffer.length };
  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    const n = Number(buffer.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(n) || n < 16 || offset + n > buffer.length) return null;
    return { offset, size:n, type, header:16, end:offset + n };
  }
  if (size < 8 || offset + size > buffer.length) return null;
  return { offset, size, type, header:8, end:offset + size };
}
function mp4Children(buffer, atom) {
  let p = atom.offset + atom.header + (atom.type === 'meta' ? 4 : 0);
  const out = [];
  while (p + 8 <= atom.end) {
    const child = mp4Atom(buffer, p);
    if (!child || child.end > atom.end) break;
    out.push(child); p = child.end;
  }
  return out;
}
function mp4FindPath(buffer, atom, types, i=0) {
  if (i >= types.length) return atom;
  for (const child of mp4Children(buffer, atom)) if (child.type === types[i]) {
    const found = mp4FindPath(buffer, child, types, i + 1);
    if (found) return found;
  }
  return null;
}
function parseMp4FreeformName(buffer, atom) {
  if (atom.type !== '----') return null;
  let mean = '', name = '';
  for (const child of mp4Children(buffer, atom)) {
    if (child.type !== 'mean' && child.type !== 'name') continue;
    const start = child.offset + child.header + 4;
    const text = buffer.subarray(start, child.end).toString('utf8').replace(/\0+$/g, '');
    if (child.type === 'mean') mean = text; else name = text;
  }
  return { mean, name };
}
function inspectMp4Buffer(input, observations) {
  let p = 0; const top = [];
  while (p + 8 <= input.length) {
    const atom = mp4Atom(input, p); if (!atom) break;
    top.push(atom); p = atom.end;
  }
  const moov = top.find(a => a.type === 'moov');
  const ilst = moov && mp4FindPath(input, moov, ['udta','meta','ilst']);
  if (!ilst) return false;
  for (const child of mp4Children(input, ilst)) {
    const ff = parseMp4FreeformName(input, child);
    if (!ff || ff.mean.toLowerCase() !== 'com.apple.itunes' || !LOVE_FIELDS.has(normalizeField(ff.name))) continue;
    const data = mp4Children(input, child).find(x => x.type === 'data');
    if (!data) { pushObservation(observations, ff.name, ''); continue; }
    const value = input.subarray(data.offset + data.header + 8, data.end).toString('utf8').trim();
    pushObservation(observations, ff.name, value);
  }
  return true;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide:true });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({stdout,stderr}) : reject(new Error(stderr.trim() || `${command} exited ${code}`)));
  });
}

async function inspectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const observations = [];
    if (ext === '.mp3') inspectId3Buffer(await fsp.readFile(filePath), observations);
    else if (ext === '.wav') inspectId3Buffer((await readWavId3(filePath)) || Buffer.alloc(0), observations);
    else if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') inspectMp4Buffer(await fsp.readFile(filePath), observations);
    else if (ext === '.flac') {
      const { stdout } = await runCommand('metaflac', ['--export-tags-to=-', filePath]);
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const eq = line.indexOf('='); if (eq < 0) continue;
        const field = normalizeField(line.slice(0, eq));
        if (LOVE_FIELDS.has(field)) pushObservation(observations, field, line.slice(eq + 1));
      }
    } else {
      const { stdout } = await runCommand('ffprobe', ['-v','error','-show_entries','format_tags','-of','json',filePath]);
      const tags = JSON.parse(stdout || '{}')?.format?.tags || {};
      for (const [field, value] of Object.entries(tags)) if (LOVE_FIELDS.has(normalizeField(field))) pushObservation(observations, field, value);
    }

    const loved = observations.some(item => item.normalized === 'L');
    const hasUnloved = observations.some(item => item.normalized === '0');
    const uniqueFields = new Set(observations.map(item => item.field));
    const uniqueValues = new Set(observations.map(item => item.normalized));
    const cleanCanonicalLoved = observations.length === 1 && observations[0].field === 'LOVE RATING' && observations[0].normalized === 'L';
    const cleanUnloved = observations.length === 0;
    let status = 'clean-unloved';
    if (cleanCanonicalLoved) status = 'clean-loved';
    else if (loved && hasUnloved) status = 'conflict';
    else if (observations.length > 1 || uniqueFields.size > 1 || uniqueValues.size > 1) status = loved ? 'duplicate-loved' : 'duplicate-unloved';
    else if (loved) status = 'legacy-loved';
    else if (hasUnloved) status = 'legacy-unloved';
    else if (!cleanUnloved) status = 'recognized';
    return {
      path:filePath, extension:ext, status, loved, observations,
      needsNormalization: !cleanCanonicalLoved && observations.length > 0,
      writable: WRITABLE_EXTENSIONS.has(ext)
    };
  } catch (err) {
    return { path:filePath, extension:ext, status:'unavailable', loved:false, observations:[], needsNormalization:false, writable:WRITABLE_EXTENSIONS.has(ext), error:err.message || String(err) };
  }
}

async function listAudioFiles(root, recursive) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes:true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (recursive) await walk(full); continue; }
      if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  await walk(root);
  out.sort((a,b) => a.localeCompare(b, undefined, { sensitivity:'base', numeric:true }));
  return out;
}
function summary(audits) {
  const counts = {};
  for (const item of audits) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}
function printAudit(audits) {
  const candidates = audits.filter(item => item.observations.length || item.status === 'unavailable');
  console.log(`\nLove metadata audit: ${audits.length.toLocaleString()} audio files inspected`);
  console.log(`Files containing recognized Love metadata: ${audits.filter(x => x.observations.length).length.toLocaleString()}`);
  console.log(`Loved by recognized value: ${audits.filter(x => x.loved).length.toLocaleString()}`);
  console.log(`Needs normalization: ${audits.filter(x => x.needsNormalization).length.toLocaleString()}`);
  console.log(`Unavailable: ${audits.filter(x => x.status === 'unavailable').length.toLocaleString()}`);
  console.log('Status counts:', summary(audits));
  if (!candidates.length) return;
  console.log('\nRecognized Love metadata:');
  for (const item of candidates) {
    console.log(`\n[${item.status}${item.writable ? '' : '; read-only format'}] ${item.path}`);
    if (item.error) console.log(`  ERROR: ${item.error}`);
    for (const tag of item.observations) console.log(`  ${tag.field} = ${JSON.stringify(tag.raw)}  -> ${tag.normalized || '(unrecognized value)'}`);
  }
}
function makeBackupDir(root) { return path.join(root, 'Hive-Love-Tag-Backups', new Date().toISOString().replace(/[:.]/g,'-')); }
async function backupFile(filePath, backupDir, audit) {
  await fsp.mkdir(backupDir, { recursive:true, mode:0o700 });
  const original = await fsp.readFile(filePath);
  const originalSha256 = crypto.createHash('sha256').update(original).digest('hex');
  const short = originalSha256.slice(0,16);
  const safe = path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, '_');
  const backupPath = path.join(backupDir, `${short}-${safe}`);
  await fsp.writeFile(backupPath, original, { mode:0o600 });
  const manifestPath = `${backupPath}.json`;
  await fsp.writeFile(manifestPath, JSON.stringify({
    hive:'Hive', purpose:'Manual Love metadata normalization backup', createdAt:new Date().toISOString(),
    originalPath:path.resolve(filePath), backupPath, originalSha256,
    detectedLoveTags:audit.observations, canonicalDecision:null
  }, null, 2), { mode:0o600 });
  return { backupPath, manifestPath, originalSha256 };
}
function createWorker() {
  const workerPath = path.resolve(__dirname, '../app/workers/metadata-worker.js');
  return fork(workerPath, [], { stdio:['ignore','ignore','inherit','ipc'] });
}
function workerWrite(worker, filePath, loved) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => { cleanup(); reject(new Error('metadata worker timed out after 30 seconds')); }, 30000);
    const onMessage = msg => {
      if (!msg || msg.path !== filePath) return;
      cleanup();
      if (msg.ok) resolve(msg); else reject(new Error(msg.error || 'metadata worker failed'));
    };
    const onExit = code => { cleanup(); reject(new Error(`metadata worker exited before completing write (code ${code})`)); };
    const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.on('exit', onExit);
    worker.send({ cmd:'love', path:filePath, loved:!!loved });
  });
}
async function promptFor(rl, item, index, total) {
  console.log(`\n=== ${index + 1}/${total} ===`);
  console.log(item.path);
  for (const tag of item.observations) console.log(`  ${tag.field} = ${JSON.stringify(tag.raw)}  -> ${tag.normalized || '(unrecognized)'}`);
  console.log(`Current recognized state: ${item.loved ? 'LOVED (L)' : 'UNLOVED/NO L'}`);
  console.log('Choose: [l] Loved / [u] Unloved / [s] Skip / [q] Quit');
  const answer = String(await new Promise(resolve => rl.question('> ', resolve))).trim().toLowerCase();
  if (answer === 'l' || answer === 'u' || answer === 's' || answer === 'q') return answer;
  return promptFor(rl, item, index, total);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return; }
  if (!opts.root) { usage(); process.exitCode = 2; return; }
  if (opts.apply && !opts.interactive) throw new Error('--apply requires --interactive so every write is manually approved.');
  const root = path.resolve(opts.root);
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const files = await listAudioFiles(root, opts.recursive);
  console.log(`Scanning ${files.length.toLocaleString()} audio files under ${root} ...`);
  const audits = new Array(files.length);
  let cursor = 0;
  const concurrency = Math.min(12, Math.max(1, files.length));
  const scanWorker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      audits[i] = await inspectFile(files[i]);
      if ((i + 1) % 250 === 0 || i + 1 === files.length) process.stdout.write(`\rInspected ${i + 1}/${files.length}`);
    }
  };
  await Promise.all(Array.from({length:concurrency}, scanWorker));
  process.stdout.write('\n');

  const reportPath = path.resolve(opts.report || path.join(process.cwd(), `hive-love-audit-${new Date().toISOString().replace(/[:.]/g,'-')}.json`));
  await fsp.writeFile(reportPath, JSON.stringify({
    hive:'Hive', tool:'hive-love-validator', createdAt:new Date().toISOString(), root,
    fileCount:files.length, summary:summary(audits), audits
  }, null, 2), { mode:0o600 });
  printAudit(audits);
  console.log(`\nAudit report: ${reportPath}`);

  if (!opts.interactive) return;
  const candidates = audits.filter(item => item.observations.length && item.needsNormalization);
  if (!candidates.length) { console.log('No Love metadata requiring normalization.'); return; }
  const rl = readline.createInterface({ input:process.stdin, output:process.stdout });
  const child = opts.apply ? createWorker() : null;
  const backupDir = opts.apply ? makeBackupDir(root) : '';
  const results = [];
  try {
    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const decision = await promptFor(rl, item, i, candidates.length);
      if (decision === 'q') break;
      if (decision === 's') { results.push({ path:item.path, action:'skipped' }); continue; }
      if (!opts.apply) { results.push({ path:item.path, action:decision === 'l' ? 'would-love' : 'would-unlove' }); continue; }
      if (!item.writable) {
        results.push({ path:item.path, action:'failed', verified:false, error:'This format is audit-only in the standalone tool; no write was attempted.' });
        console.error('  ✗ Audit-only format; no write attempted.');
        continue;
      }
      const backup = await backupFile(item.path, backupDir, item);
      try {
        await workerWrite(child, item.path, decision === 'l');
        const after = await inspectFile(item.path);
        const expectedClean = decision === 'l'
          ? after.observations.length === 1 && after.observations[0].field === 'LOVE RATING' && after.observations[0].normalized === 'L'
          : after.observations.length === 0;
        if (!expectedClean) throw new Error('Post-write validation did not produce the requested canonical state.');
        results.push({ path:item.path, action:decision === 'l' ? 'loved' : 'unloved', backup, verified:true });
        console.log(`  ✓ ${decision === 'l' ? 'LOVE RATING=L' : 'all Love fields removed'} verified`);
      } catch (err) {
        results.push({ path:item.path, action:'failed', backup, verified:false, error:err.message });
        console.error(`  ✗ ${err.message}`);
      }
    }
  } finally {
    rl.close();
    if (child) { try { child.disconnect(); } catch {} try { child.kill(); } catch {} }
  }
  const appliedReport = reportPath.replace(/\.json$/i, '-decisions.json');
  await fsp.writeFile(appliedReport, JSON.stringify({
    hive:'Hive', tool:'hive-love-validator', createdAt:new Date().toISOString(), root,
    apply:opts.apply, backupDir:backupDir || null, results
  }, null, 2), { mode:0o600 });
  console.log(`\nManual decisions: ${appliedReport}`);
  if (opts.apply) console.log(`Backups: ${backupDir}`);
}

main().catch(err => { console.error(`Love validator: ${err.message || err}`); process.exitCode = 1; });
