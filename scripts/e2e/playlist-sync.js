#!/usr/bin/env node
'use strict';
// Playlists are the same on the PC and the phone: made, renamed and deleted on either side.
//
//   node scripts/e2e/playlist-sync.js <Hive runtime binary> <Hive Mobile APK>
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
if (!RUNTIME || !APK) { console.error('usage: playlist-sync.js <Hive runtime> <Hive Mobile APK>'); process.exit(2); }
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
  sh(`input tap ${n.x} ${n.y + 60}`); await wait(600);
  sh('input keyevent KEYCODE_MOVE_END'); for (let i = 0; i < 30; i++) sh('input keyevent KEYCODE_DEL');
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

// ---- the run ----------------------------------------------------------------
const pcPlaylists = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'playlists.json'), 'utf8')); } catch { return []; } };
async function phonePlaylists() {
  reopenPhone(); await wait(6000);
  // The Playlists tab: swipe the tab row to its start, then open it.
  sh('input swipe 200 358 900 358 300'); await wait(800);
  await tap('Playlists'); await wait(1500);
  const names = new Set(screen().map(n => n.text));
  return names;
}
(async () => {
  try {
    console.log(`work folder: ${WORK}`);
    execFileSync('python3', ['-I', path.join(__dirname, 'make-sample-library.py'), PC_MUSIC, PHONE_SONGS]);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ folders: [PC_MUSIC], embedPlayCounts: true }));
    startHive();
    await until('Hive Link', async () => (await link('GET', '/api/ping')).status === 200, 180000);
    const pairForHarness = await evaluate('window.beehive.hiveLinkPair()');
    token = (await link('POST', '/api/pair', { code: pairForHarness.code, deviceName: 'e2e harness' })).body.token;
    const lib = await until('library scanned', async () => { const l = await library(); return l.length >= 8 ? l : null; }, 240000);

    // A phone with the PC's songs on it (so the two match), paired and trusted.
    sh('locksettings set-disabled true; settings put global stay_on_while_plugged_in 3; settings put system screen_off_timeout 1800000; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard');
    try { adb('uninstall', PKG); } catch {}
    sh(`rm -r '/sdcard/Music' 2>/dev/null; mkdir -p '${PHONE_ROOT}'`);
    const pcFiles = execFileSync('find', [PC_MUSIC, '-type', 'f', '(', '-name', '*.mp3', '-o', '-name', '*.flac', '-o', '-name', '*.m4a', ')'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of pcFiles) adb('push', f, `${PHONE_ROOT}/${path.basename(f)}`);
    sh('content call --uri content://media --method scan_volume --arg external_primary >/dev/null');
    adb('install', '-r', '-g', APK);
    reopenPhone(); await wait(5000);
    const pairing = await evaluate('window.beehive.hiveLinkPair()');
    await tap('More options'); await tap('Settings');
    await type('PC address', '10.0.2.2'); await type('Port', String(PORT)); await type('Pairing code', pairing.code);
    await tap('Pair', { scroll: true });
    const phone = await until('the phone paired', async () => (await evaluate('window.beehive.hiveLinkDevices()')).find(d => d.name !== 'e2e harness'), 60000);
    await evaluate(`window.beehive.hiveLinkTrust(${JSON.stringify(phone.id)}, true)`);
    check('The phone pairs and is trusted', !!phone);

    // 1. Made on the PC: on the phone.
    // Hive Link's song list has no paths; the playlist takes the songs' files as Hive's editor does.
    const two = ['01 Opening.mp3', '01 Clear.flac'].map(n => pcFiles.find(f => path.basename(f) === n));
    await evaluate(`window.beehive.savePlaylist(${JSON.stringify({ name: 'PC Mix', tracks: two })})`);
    const seen = await until('PC Mix on the phone', async () => { const n = await phonePlaylists(); return n.has('PC Mix') ? n : null; }, 180000, 3000).catch(() => null);
    check('A playlist made on the PC appears on the phone', !!seen);
    const row = seen && screen().find(n => n.text === 'PC Mix');
    const under = row && screen().find(n => n.y > row.y && n.y < row.y + 90 && /tracks?$/.test(n.text));
    check('…with its songs', under?.text === '2 tracks', under?.text);
    check('…with no separate "on your PC" list', seen && ![...seen].some(t => /^Hive on|On your PC$/.test(t)), seen && [...seen].filter(t => /PC|Hive on/.test(t)).join(', '));

    // 2. Made on the phone: on the PC.
    await tap('New playlist'); await tap('Playlist'); await wait(800);
    // The name box has the keyboard as the dialog opens.
    sh(`input text 'Phone%sMix'`); await wait(400);
    await tap('Create'); await wait(1000);
    const made = await until('Phone Mix on the PC', () => pcPlaylists().find(p => p.name === 'Phone Mix'), 60000, 2000).catch(() => null);
    check('A playlist made on the phone appears on the PC', !!made);

    // 3. Renamed on the PC: renamed on the phone.
    if (made) {
      const pl = (await evaluate('window.beehive.getPlaylists()')).find(p => p.name === 'Phone Mix');
      await evaluate(`window.beehive.savePlaylist(${JSON.stringify({ ...pl, name: 'Phone Mix renamed' })})`);
      const renamed = await until('rename on the phone', async () => { const n = await phonePlaylists(); return n.has('Phone Mix renamed') ? n : null; }, 180000, 3000).catch(() => null);
      check('Renaming on the PC renames it on the phone', renamed && !renamed.has('Phone Mix'));
    }

    // 4. Deleted on the phone: deleted on the PC, and kept aside there.
    await phonePlaylists();
    await tap('PC Mix'); await wait(2000);
    await tap('Playlist options'); await tap('Delete playlist'); await tap('Delete');
    const gone = await until('PC Mix gone from the PC', () => !pcPlaylists().some(p => p.name === 'PC Mix'), 60000, 2000).catch(() => false);
    check('Deleting on the phone deletes it on the PC', gone);
    let kept = []; try { kept = JSON.parse(fs.readFileSync(path.join(DATA, 'deleted-playlists.json'), 'utf8')); } catch {}
    check('…and the PC keeps it in deleted-playlists.json', kept.some(k => k.playlist?.name === 'PC Mix'));
    check('The PC backed up its playlists before the phone changed them', fs.readdirSync(DATA).some(f => /^playlists\.before-phone-/.test(f)));
    const names = pcPlaylists().map(p => p.name);
    check('Nothing duplicated on the PC', names.length === new Set(names).size, names.join(', '));
  } catch (e) {
    check('run', false, e.stack || e.message);
  } finally {
    await stopHive();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed  (work folder: ${WORK})`);
    process.exit(failed ? 1 : 0);
  }
})();
