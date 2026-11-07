#!/usr/bin/env node
'use strict';
// A new user's first day with Hive and Hive Mobile, end to end, then a reinstall.
//
//   node scripts/e2e/fresh-user.js <Hive runtime binary> <Hive Mobile APK>
//
// Needs: an Android emulator on E2E_SERIAL (default emulator-5560) that may be wiped,
// xvfb-run, ffmpeg, python3. Hive runs from this checkout with its own empty data
// folder and port, so a Hive already open on this computer is never touched.
//
// The phone is driven through its screens (as a person would) where that's the point
// of the step, and through adb where it's the user's say-so (allowing permissions).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const [RUNTIME, APK] = process.argv.slice(2);
if (!RUNTIME || !APK) { console.error('usage: fresh-user.js <Hive runtime> <Hive Mobile APK>'); process.exit(2); }
const REPO = path.resolve(__dirname, '..', '..');
const SERIAL = process.env.E2E_SERIAL || 'emulator-5560';
const PORT = 48910, CDP = 9340;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-'));
const PC_MUSIC = path.join(WORK, 'pc-music'), PHONE_SONGS = path.join(WORK, 'phone-music'), DATA = path.join(WORK, 'data');
const PHONE_ROOT = '/sdcard/Music/My Music';
const PKG = 'com.local.hive.mobile';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 120000, every = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await wait(every);
  }
}

// ---- the phone --------------------------------------------------------------
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const sh = cmd => adb('shell', cmd);
function screen() {
  sh('uiautomator dump /sdcard/e2e-ui.xml >/dev/null');
  const xml = sh('cat /sdcard/e2e-ui.xml');
  return [...xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
    .map(m => ({ text: m[1], desc: m[2], x: (+m[3] + +m[5]) >> 1, y: (+m[4] + +m[6]) >> 1 }));
}
function find(label) { return screen().find(n => n.text === label || n.desc === label); }
async function tap(label, { scroll = false } = {}) {
  for (let i = 0; i < (scroll ? 8 : 1); i++) {
    const n = find(label);
    if (n) { sh(`input tap ${n.x} ${n.y}`); await wait(800); return true; }
    if (scroll) { sh('input swipe 540 1800 540 700 300'); await wait(700); }
  }
  // Home's tabs scroll sideways: a tab off to the right is swiped into view.
  for (let i = 0; i < 4; i++) {
    sh('input swipe 900 360 200 360 250'); await wait(600);
    const n = find(label);
    if (n) { sh(`input tap ${n.x} ${n.y}`); await wait(800); return true; }
  }
  // What was on screen, for whoever reads the failure.
  try { fs.writeFileSync(path.join(os.tmpdir(), `hive-e2e-missing-${label.replace(/\W+/g, '_')}.png`), execFileSync('adb', ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })); } catch {}
  throw new Error(`nothing on screen called "${label}"`);
}
// A text field: its label is drawn in capitals just above the box, so the box below the label is tapped.
async function type(label, value) {
  let n = null;
  for (let i = 0; i < 8 && !n; i++) {
    n = screen().find(x => x.text.toLowerCase() === label.toLowerCase());
    if (!n) { sh('input swipe 540 1800 540 700 300'); await wait(700); }
  }
  if (!n) throw new Error(`no field called "${label}"`);
  sh(`input tap ${n.x} ${n.y + 60}`); await wait(900);
  // Cleared from both ends: right after the tap the cursor may not be at the end yet, and a field that kept
  // part of its old value ("47800" + "48910") made pairing fail now and then.
  sh('input keyevent KEYCODE_MOVE_END'); await wait(150); for (let i = 0; i < 30; i++) sh('input keyevent KEYCODE_DEL');
  sh('input keyevent KEYCODE_MOVE_HOME'); await wait(150); for (let i = 0; i < 30; i++) sh('input keyevent KEYCODE_FORWARD_DEL');
  sh(`input text '${value.replace(/ /g, '%s')}'`); await wait(400);
  // The keyboard moves everything; it goes before the next field is looked for.
  if (/mInputShown=true/.test(sh('dumpsys input_method'))) { sh('input keyevent KEYCODE_BACK'); await wait(700); }
}
function phoneFiles() {
  const out = sh(`find '${PHONE_ROOT}' -type f -printf '%s\\t%P\\n' 2>/dev/null`);
  return new Map(out.split('\n').filter(Boolean).map(l => { const [s, p] = l.split('\t'); return [p, +s]; }));
}
// Always opened with "Connect automatically" off: the test phone must never find and pair with a
// Hive already running on this computer (it's on the same network as the emulator).
function reopenPhone() { sh(`am force-stop ${PKG}`); sh(`am start -n ${PKG}/.MainActivity --ez no_auto_connect true`); }
const logcat = tag => sh(`logcat -d -v raw -s ${tag}`);

// ---- Hive on the computer ---------------------------------------------------
let hive = null, cdpSocket = null, cdpId = 0;
// Electron can hang on the way out ("Failed to shutdown"), keeping the test's ports. Only the test's
// own Hive is matched: the runtime binary at the start of the command line, with the test's debugging port.
function killTestHive() {
  const pattern = `^${RUNTIME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*--remote-debugging-port=${CDP}`;
  try { execFileSync('pkill', ['-9', '-f', pattern]); } catch {}
}
function startHive() {
  killTestHive();
  const log = fs.openSync(path.join(WORK, 'hive.log'), 'a');
  hive = spawn('xvfb-run', ['-a', RUNTIME, REPO, `--remote-debugging-port=${CDP}`], {
    env: { ...process.env, HIVE_DATA_ROOT: DATA, HIVE_LINK_PORT: String(PORT), DBUS_SESSION_BUS_ADDRESS: 'disabled:', HIVE_AUDIO_OUTPUT_DEVICE: 'alsa:null' },
    stdio: ['ignore', log, log], detached: true,
  });
}
async function stopHive() {
  if (cdpSocket) { try { cdpSocket.close(); } catch {} cdpSocket = null; }
  if (hive) { try { process.kill(-hive.pid, 'SIGTERM'); } catch {} hive = null; }
  await wait(4000);
  killTestHive();
  await wait(1000);
}
async function cdp() {
  if (cdpSocket) return cdpSocket;
  const pages = await until('Hive window', async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
    return list.find(p => p.type === 'page' && /index\.html/.test(p.url));
  }, 180000);
  cdpSocket = new WebSocket(pages.webSocketDebuggerUrl);
  await new Promise((res, rej) => { cdpSocket.onopen = res; cdpSocket.onerror = rej; });
  return cdpSocket;
}
async function evaluate(expression) {
  const ws = await cdp();
  const id = ++cdpId;
  const reply = new Promise(res => {
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
    ws.addEventListener('message', on);
  });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const m = await reply;
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'evaluate failed');
  return m.result?.result?.value;
}
// The harness reads Hive's state through Hive Link, as a second paired "phone".
let token = null;
function link(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { let b = Buffer.concat(chunks); if (res.headers['content-encoding'] === 'gzip') b = require('zlib').gunzipSync(b); resolve({ status: res.statusCode, body: b.length ? JSON.parse(b) : null }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function library() { return (await link('GET', '/api/library')).body?.tracks || []; }
const song = (lib, title) => lib.find(t => t.title === title);
const stats = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'play-stats.json'), 'utf8')); } catch { return {}; } };
const playsOf = name => Object.entries(stats()).find(([p]) => p.endsWith(name))?.[1]?.playCount || 0;
function fileTag(file, tag) {
  return execFileSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'resources'))})
import mutagen; f = mutagen.File(sys.argv[1]); t = f.tags or {}
v = [str(x) for k in t.keys() if k.split(':')[-1].upper() == sys.argv[2] for x in (t[k].text if hasattr(t[k], 'text') else t[k])]
print(v[0] if v else '')`, file, tag], { encoding: 'utf8' }).trim();
}
async function freshInstallChecks(when) {
  const lib = await until('library scanned', async () => { const l = await library(); return l.length >= 8 ? l : null; }, 240000);
  const one = song(lib, 'Opening');
  check(`${when}: Favorites from the files`, ['Opening', 'Clear', 'Apple Song', 'Jóga ✨'].every(t => song(lib, t)?.loved), lib.filter(t => t.loved).map(t => t.title).join(', '));
  check(`${when}: star ratings from the files`, one?.rating === 4 && song(lib, 'Second')?.rating === 2, `Opening ${one?.rating}, Second ${song(lib, 'Second')?.rating}`);
  await until('play counts adopted', () => playsOf('01 Opening.mp3') >= 7, 60000).catch(() => {});
  check(`${when}: play counts from the files`, playsOf('01 Opening.mp3') === 7 && playsOf('01 Clear.flac') === 3 && playsOf('Apple Song.m4a') === 12 && playsOf('Волны.mp3') === 2,
    `Opening ${playsOf('01 Opening.mp3')}, Clear ${playsOf('01 Clear.flac')}, Apple Song ${playsOf('Apple Song.m4a')}, Волны ${playsOf('Волны.mp3')}`);
  check(`${when}: names in other scripts, emoji and a leading dot`, song(lib, 'Волны') && song(lib, 'Jóga ✨') && song(lib, '.Dot Song'));
  return lib;
}

// ---- the day ----------------------------------------------------------------
(async () => {
  try {
    console.log(`work folder: ${WORK}`);
    execFileSync('python3', ['-I', path.join(__dirname, 'make-sample-library.py'), PC_MUSIC, PHONE_SONGS]);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ folders: [PC_MUSIC], embedPlayCounts: true }));

    // 1. A new computer: Hive reads the library, Favorites, ratings and plays from the files.
    startHive();
    await until('Hive Link', async () => (await link('GET', '/api/ping')).status === 200, 180000);
    const pairForHarness = await evaluate('window.beehive.hiveLinkPair()');
    const harness = (await link('POST', '/api/pair', { code: pairForHarness.code, deviceName: 'e2e harness' })).body;
    token = harness.token;
    // Trusted, so it may read Hive's file list (the file mirror is only for trusted phones).
    await evaluate(`window.beehive.hiveLinkTrust(${JSON.stringify(harness.deviceId)}, true)`);
    await freshInstallChecks('New computer');

    // 2. A new phone: nothing of Hive's on it, a few songs of its own.
    // The test phone awake, unlocked and staying on for the run.
    sh('locksettings set-disabled true; settings put global stay_on_while_plugged_in 3; settings put system screen_off_timeout 1800000; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard');
    try { adb('uninstall', PKG); } catch {}
    // A new phone: no music and no Hive backup left by an earlier run (that would look like a reinstall).
    sh(`rm -r '/sdcard/Music' '/sdcard/Documents/Hive' '/sdcard/Documents/Hive Mobile' 2>/dev/null; mkdir -p '${PHONE_ROOT}'`);
    for (const f of fs.readdirSync(PHONE_SONGS)) adb('push', path.join(PHONE_SONGS, f), `${PHONE_ROOT}/${f}`);
    sh(`content call --uri content://media --method scan_volume --arg external_primary >/dev/null`);
    adb('install', '-r', '-g', APK);
    sh('logcat -c');
    reopenPhone(); await wait(5000);
    check('Hive Mobile opens on a new phone', find('Hive') || find('More options'));

    // 3. Pairing, through the phone's Settings, with the code Hive shows.
    const pairing = await evaluate('window.beehive.hiveLinkPair()');
    await tap('More options'); await tap('Settings');
    // Settings › Your PC › "Connect to Hive on your PC" (its own page since 2.25.2).
    await tap('Connect to Hive on your PC', { scroll: true });
    await type('PC address', '10.0.2.2'); await type('Port', String(PORT)); await type('Pairing code', pairing.code);
    await tap('Pair', { scroll: true });
    const phone = await until('the phone paired', async () => (await evaluate('window.beehive.hiveLinkDevices()')).find(d => d.name !== 'e2e harness'), 60000);
    check('The phone pairs with the code', !!phone, phone?.name);

    // 4. Song sync, before the phone is trusted: plain song sync, not the file mirror.
    await until('song sync can start', async () => {
      if (find('Start song sync')) return true;
      if (find('Check')) await tap('Check');
      sh('input swipe 540 1800 540 900 300'); await wait(1500);
      return !!find('Start song sync');
    }, 180000, 1000);
    await tap('Start song sync');
    await until('songs reached the phone', async () => { const f = phoneFiles(); return f.size >= 3 + 8 ? f : null; }, 300000, 5000);
    check('Before trusting: the PC\'s songs reach the phone', phoneFiles().size >= 11, `${phoneFiles().size} files on the phone`);
    await until('the phone\'s songs reached the PC', async () => (await library()).filter(t => t.artist === 'Phone Artist').length === 3, 300000, 5000);
    check('Before trusting: the phone\'s songs reach the PC', true);

    // 5. The user trusts the phone and allows All files access: the file mirror takes over.
    await evaluate(`window.beehive.hiveLinkTrust(${JSON.stringify(phone.id)}, true)`);
    sh(`appops set ${PKG} MANAGE_EXTERNAL_STORAGE allow`);
    sh('logcat -c'); reopenPhone();
    const plan = await until('the file mirror ran', () => logcat('HiveSongSync').split('\n').find(l => l.startsWith('file mirror:')), 300000, 5000);
    check('After trusting: the file mirror takes over', !!plan, plan);
    check('Files song sync filed elsewhere are moved, not copied again', / [1-9]\d* moved/.test(plan) && / 0 to the PC/.test(plan), plan);
    const pcList = (await link('GET', '/api/files')).body?.files || [];
    await until('mirror done', async () => { const f = phoneFiles(); return pcList.every(x => f.has(x.p.replace(/(^|\/)\.(?=[^/]*\.(mp3|flac)$)/i, '$1_'))) ? f : null; }, 300000, 5000).catch(() => {});
    const onPhone = phoneFiles();
    const pcNow = new Map(((await link('GET', '/api/files')).body?.files || []).map(f => [f.p.replace(/(^|\/)\.(?=[^/]*\.(mp3|flac)$)/i, '$1_'), f.s]));
    const missing = [...pcNow].filter(([p, s]) => onPhone.get(p) !== s).map(([p]) => p);
    const extra = [...onPhone.keys()].filter(p => !pcNow.has(p));
    check('Phone and PC hold the same files, byte for byte in size', !missing.length && !extra.length, `${missing.length} missing/different on the phone, ${extra.length} only on the phone ${[...missing, ...extra].slice(0, 4).join(' | ')}`);

    // 6. Changes on each side cross over.
    const sentFiles = () => (fs.readFileSync(path.join(WORK, 'hive.log'), 'utf8').match(/phone sent a file(?!'s tags)/g) || []).length;
    const sha = f => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    // One to one: the phone's copy is the PC's file, byte for byte.
    const sameFile = (pcFile, phonePath, pulledTo) => { adb('pull', phonePath, pulledTo); return sha(pcFile) === sha(pulledTo); };
    const sentBefore = sentFiles();
    const second = path.join(PC_MUSIC, 'Artist A', 'First Album', '02 Second.mp3');
    await evaluate(`window.beehive.setLove([${JSON.stringify(second)}], true)`);
    await until('Love written to the file', () => fileTag(second, 'LOVE RATING') === 'L', 30000);
    check('A Favorite set on the PC is written into the file', true);
    sh('logcat -c'); reopenPhone();
    const secondOnPhone = `${PHONE_ROOT}/Artist A/First Album/02 Second.mp3`;
    const pulled = path.join(WORK, 'second-from-phone.mp3');
    await until('the newer file reached the phone', async () => { adb('pull', secondOnPhone, pulled); return fileTag(pulled, 'LOVE RATING') === 'L'; }, 300000, 5000).catch(() => {});
    check("…and the phone's copy of the file gets it too", fs.existsSync(pulled) && fileTag(pulled, 'LOVE RATING') === 'L');
    check('…byte for byte the same file as the PC\'s', await until('one to one', () => sameFile(second, secondOnPhone, pulled), 120000, 5000).catch(() => false));

    // Tags edited on the phone (its song menu › More › Edit tags) are written into the PC's file, and the
    // phone's copy ends up the same.
    await tap('Tracks');
    let hit = null, asked = false;
    for (let i = 0; i < 8 && !hit; i++) {
      const s = screen(), row = s.find(n => n.text === 'Second');
      if (row) hit = s.filter(n => n.desc === 'More options' && Math.abs(n.y - row.y) < 90).sort((a, b) => b.x - a.x)[0];
      if (!hit) { sh('input swipe 540 1800 540 700 300'); await wait(700); }
    }
    if (hit) { sh(`input tap ${hit.x} ${hit.y}`); await wait(900); await tap('More'); await tap('Edit tags'); await wait(1500); /* the sheet slides up first */ await type('Genre', 'Phone Edit'); if (!find('Phone Edit')) hit = null; else { await tap('Save'); await wait(1500); if (find('ALLOW')) { asked = true; await tap('ALLOW'); } } }
    await until('the phone\'s edit in the PC\'s file', () => fileTag(second, 'TCON') === 'Phone Edit', 300000, 5000).catch(() => {});
    check('A tag edited on the phone is written into the PC\'s file', fileTag(second, 'TCON') === 'Phone Edit', hit ? `${fileTag(second, 'TCON')}${asked ? ' (Android asked to allow the change)' : ''}` : 'the edit couldn\'t be made on the phone');
    sh('logcat -c'); reopenPhone();
    await until('the phone\'s copy has the edit', async () => { adb('pull', secondOnPhone, pulled); return fileTag(pulled, 'TCON') === 'Phone Edit'; }, 300000, 5000).catch(() => {});
    check('…and the phone\'s copy has it too, with its Favorite kept', fileTag(pulled, 'TCON') === 'Phone Edit' && fileTag(pulled, 'LOVE RATING') === 'L', `${fileTag(pulled, 'TCON')} / ${fileTag(pulled, 'LOVE RATING')}`);
    check('…and the two are one file again, byte for byte', await until('one to one', () => sameFile(second, secondOnPhone, pulled), 120000, 5000).catch(() => false));

    // 6a. Tags and covers changed on one side go across as tags, never as the whole file: the other
    //     side's own tags (Love, play counts) stay as they are, and the audio is never re-sent.
    const opening = path.join(PC_MUSIC, 'Artist A', 'First Album', '01 Opening.mp3');
    const openingOnPhone = `${PHONE_ROOT}/Artist A/First Album/01 Opening.mp3`;
    const openingPulled = path.join(WORK, 'opening-from-phone.mp3');
    const art = path.join(WORK, 'new-cover.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2a9d8f:s=300x300', '-frames:v', '1', art]);
    const artHash = require('crypto').createHash('sha256').update(fs.readFileSync(art)).digest('hex');
    const coverHash = file => execFileSync('python3', ['-I', '-c', `import sys, hashlib; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'resources'))})
import mutagen; t = mutagen.File(sys.argv[1]).tags or {}
p = [t[k].data for k in t.keys() if k.startswith('APIC')]
print(hashlib.sha256(p[0]).hexdigest() if p else '')`, file], { encoding: 'utf8' }).trim();
    await evaluate(`window.beehive.writeTags(${JSON.stringify(opening)}, { genre: 'PC Edit' })`);
    await evaluate(`window.beehive.writeArtwork(${JSON.stringify(opening)}, ${JSON.stringify(art)}, { pictureType: 'Cover (Front)' })`);
    sh('logcat -c'); reopenPhone();
    await until('the PC\'s tag edit on the phone', async () => { adb('pull', openingOnPhone, openingPulled); return fileTag(openingPulled, 'TCON') === 'PC Edit' && coverHash(openingPulled) === artHash; }, 300000, 5000).catch(() => {});
    const bySync = logcat('HiveSongSync').split('\n').find(l => /^tag sync: [1-9]/.test(l));
    check('A tag and a cover changed on the PC reach the phone by its tags, not the song', fileTag(openingPulled, 'TCON') === 'PC Edit' && coverHash(openingPulled) === artHash && !!bySync,
      `${fileTag(openingPulled, 'TCON')}, cover ${coverHash(openingPulled) === artHash ? 'new' : 'old'}; ${bySync || 'no tag sync logged'}`);
    check('…its Favorite and play count kept', fileTag(openingPulled, 'LOVE RATING') === 'L' && fileTag(openingPulled, 'P_COUNT') === '7', `${fileTag(openingPulled, 'LOVE RATING')} / P_COUNT ${fileTag(openingPulled, 'P_COUNT')}`);
    check('…byte for byte the PC\'s file', sameFile(opening, openingOnPhone, openingPulled));
    // Changed in the phone's own file (another app, a tag edit Hive didn't see): its tags go to the PC.
    execFileSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'resources'))})
from mutagen.id3 import ID3, TALB; t = ID3(sys.argv[1]); t.add(TALB(encoding=3, text=['First Album (Phone)'])); t.save()`, openingPulled]);
    adb('push', openingPulled, openingOnPhone); sh(`touch '${openingOnPhone}'`);
    sh('logcat -c'); reopenPhone();
    await until('the phone file\'s tag on the PC', () => fileTag(opening, 'TALB') === 'First Album (Phone)', 300000, 5000).catch(() => {});
    check('A tag changed in the phone\'s file reaches the PC by its tags', fileTag(opening, 'TALB') === 'First Album (Phone)', fileTag(opening, 'TALB'));
    check('…and the PC\'s play count in the file stays', fileTag(opening, 'P_COUNT') === '7', `P_COUNT ${fileTag(opening, 'P_COUNT')}`);
    check('…and the PC\'s file is the phone\'s, byte for byte', sameFile(opening, openingOnPhone, path.join(WORK, 'opening-check.mp3')));
    check('No whole file went from the phone to the PC for any Love, tag or cover change', sentFiles() === sentBefore, `${sentFiles() - sentBefore} files sent`);

    // A play on the phone counts on the PC, in its history, and in the file.
    // Where Hive filed the phone's song (Artist/Album/Title), found by its file.
    const phoneSongName = String(fs.readdirSync(PC_MUSIC, { recursive: true }).find(p => /(^|\/)(Phone Artist - )?Phone Song\.mp3$/.test(String(p))));
    const before = playsOf(phoneSongName);
    await tap('Tracks');
    await tap('Phone Song', { scroll: true });
    await wait(26000);
    sh('input keyevent KEYCODE_MEDIA_PAUSE');
    sh('logcat -c'); reopenPhone();
    await until('the phone play counted', () => playsOf(phoneSongName) > before, 180000, 5000).catch(() => {});
    check('A play on the phone counts on the PC', playsOf(phoneSongName) === before + 1, `${before} → ${playsOf(phoneSongName)}`);
    const events = JSON.parse(fs.readFileSync(path.join(DATA, 'listening-events.json'), 'utf8'));
    check('…in the PC\'s listening history', events.some(e => e.source === 'hive-mobile' && e.title === 'Phone Song'));
    const phonePcFile = (await library()).length && fs.readdirSync(PC_MUSIC, { recursive: true }).find(p => String(p).endsWith('Phone Song.mp3') && !String(p).includes('Second'));
    check('…and in the file\'s play count', phonePcFile && +fileTag(path.join(PC_MUSIC, String(phonePcFile)), 'P_COUNT') === before + 1, `P_COUNT ${phonePcFile && fileTag(path.join(PC_MUSIC, String(phonePcFile)), 'P_COUNT')}`);
    sh('logcat -c'); reopenPhone();
    const sameHistory = await until('history copied to the phone', async () => {
      adb('pull', '/sdcard/Documents/Hive/listening-events.json', path.join(WORK, 'phone-history.json'));
      return fs.readFileSync(path.join(WORK, 'phone-history.json')).equals(fs.readFileSync(path.join(DATA, 'listening-events.json')));
    }, 180000, 5000).catch(() => false);
    check('The phone keeps a byte-for-byte copy of the listening history', sameHistory);

    // A song deleted on the PC goes from the phone too: the user allowed deletions to sync (a trusted
    // phone), and only an unusually large batch (over 40) waits to be asked about.
    await evaluate(`window.beehive.deleteTracksFromDisk([${JSON.stringify(path.join(PC_MUSIC, 'Loose', 'untagged.ogg'))}])`);
    sh('logcat -c'); reopenPhone();
    const gone = await until('the phone removed it', () => !phoneFiles().has('Loose/untagged.ogg'), 240000, 5000).catch(() => false);
    check('A song deleted on the PC goes from the phone too', gone);
    check('…without asking, as the user chose', !/deleted on your PC/.test(sh('dumpsys notification --noredact')));

    // 6b. Hive closed in the middle of a copy (the PC shut down, Wi-Fi gone): the phone keeps no broken
    //     half-file, and the next sync finishes the copy whole.
    const bigPath = path.join(PC_MUSIC, 'Archive', 'big mix.bin');
    fs.mkdirSync(path.dirname(bigPath), { recursive: true });
    { const fd = fs.openSync(bigPath, 'w'); const chunk = require('crypto').randomBytes(4 << 20); for (let i = 0; i < 75; i++) fs.writeSync(fd, chunk); fs.closeSync(fd); }
    const bigSize = fs.statSync(bigPath).size;
    sh('logcat -c'); reopenPhone();
    const started = await until('the big copy started', () => /hive-mirror-part/.test(sh(`ls -a '${PHONE_ROOT}/Archive' 2>/dev/null`)), 240000, 500).catch(() => false);
    await stopHive();
    // The phone may only notice the connection is dead when its 30 s read timeout runs out.
    await until('the half file is gone', () => !/hive-mirror-part/.test(sh(`ls -a '${PHONE_ROOT}/Archive' 2>/dev/null`)), 60000, 2000).catch(() => {});
    const afterCut = sh(`ls -la '${PHONE_ROOT}/Archive' 2>/dev/null`);
    check('Cut off mid-copy: the copy had started', started);
    check('…and the phone keeps no broken half-file', !/hive-mirror-part/.test(afterCut) && !phoneFiles().has('Archive/big mix.bin'), afterCut.split('\n').filter(l => /big|part/.test(l)).join(' | '));
    startHive();
    await until('Hive Link back', async () => (await link('GET', '/api/ping')).status === 200, 180000);
    sh('logcat -c'); reopenPhone();
    await until('the big copy finished', () => phoneFiles().get('Archive/big mix.bin') === bigSize, 300000, 5000).catch(() => {});
    check('…and the next sync finishes the copy whole', phoneFiles().get('Archive/big mix.bin') === bigSize, `${phoneFiles().get('Archive/big mix.bin')} of ${bigSize} bytes`);

    // 7. A reinstall: Hive's data gone, only the music folder chosen again.
    await stopHive();
    // A wiped computer: Hive's data and its backup both gone, only the music files left.
    fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });
    fs.rmSync(path.join(WORK, 'User Data Backup'), { recursive: true, force: true });
    fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ folders: [PC_MUSIC], embedPlayCounts: true }));
    startHive();
    await until('Hive Link after the reinstall', async () => (await link('GET', '/api/ping')).status === 200, 180000);
    const again = await evaluate('window.beehive.hiveLinkPair()');
    token = (await link('POST', '/api/pair', { code: again.code, deviceName: 'e2e harness' })).body.token;
    const lib = await freshInstallChecks('Reinstalled');
    check('Reinstalled: the Favorite set later is still there', song(lib, 'Second')?.loved === true);
    check('Reinstalled: the phone\'s play is still counted', playsOf(phoneSongName) === before + 1, `${playsOf(phoneSongName)}`);
    check('Reinstalled: the phone\'s songs are in the library', lib.filter(t => t.artist === 'Phone Artist').length === 3);
  } catch (e) {
    check('run', false, e.stack || e.message);
  } finally {
    await stopHive();
    const failed = results.filter(r => !r.ok).length;
    // The work folder sits in a RAM disk on many systems: kept after a failure (to look into), minus the
    // 300 MB test file; removed after a pass. Only ever our own hive-e2e-* folder in the temp folder.
    if (path.dirname(WORK) === os.tmpdir() && path.basename(WORK).startsWith('hive-e2e-')) {
      try {
        if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
        else for (const f of fs.readdirSync(WORK, { recursive: true })) if (/big mix\.bin$/.test(String(f))) fs.rmSync(path.join(WORK, String(f)), { force: true });
      } catch {}
    }
    console.log(`\n${results.length - failed} passed, ${failed} failed${failed ? `  (work folder: ${WORK})` : ''}`);
    process.exit(failed ? 1 : 0);
  }
})();
