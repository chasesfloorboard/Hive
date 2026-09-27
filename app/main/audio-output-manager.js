'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function cleanText(value, fallback = '') {
  return String(value || '').replace(/\s+/g, ' ').trim() || fallback;
}

function parsePactlJson(text) {
  let parsed;
  try { parsed = JSON.parse(String(text || '')); } catch { return []; }
  const sinks = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sinks) ? parsed.sinks : []);
  return sinks.map((sink, index) => {
    const props = sink?.properties && typeof sink.properties === 'object' ? sink.properties : {};
    const name = cleanText(sink?.name);
    const description = cleanText(sink?.description || props['node.description'] || props['device.description'], name || `Audio output ${index + 1}`);
    const alsaCard = props['api.alsa.card'] ?? props['alsa.card'];
    return name ? {
      id: name,
      name: description,
      description,
      state: cleanText(sink?.state, 'unknown'),
      server: 'PulseAudio/PipeWire compatibility',
      ...(alsaCard != null && alsaCard !== '' ? { alsaCard: Number(alsaCard), alsaDevice: Number(props['alsa.device'] ?? props['api.alsa.pcm.device'] ?? 0) } : {})
    } : null;
  }).filter(Boolean);
}

function parsePactlShort(text) {
  return String(text || '').split(/\r?\n/).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const name = parts[1];
    const description = cleanText(parts.slice(2).join(' '), name);
    return { id: name, name: description, description, state: 'unknown', server: 'PulseAudio/PipeWire compatibility' };
  }).filter(Boolean);
}

// Bit-perfect outputs: every ALSA hardware playback device, opened directly
// by the native helper (id "alsa:hw:CARD=<id>,DEV=<n>") instead of through
// PipeWire. /proc/asound/cards gives each card's short id and full name;
// /proc/asound/pcm lists its playback devices ("05-00: ... : playback 1").
function parseAlsaPlaybackDevices(cardsText, pcmText) {
  const cards = new Map();
  const lines = String(cardsText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(\d+)\s+\[([^\]]+)\]\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const longName = cleanText(String(lines[i + 1] || '').replace(/\s+at\s+.*$/, ''), cleanText(m[3]));
    cards.set(Number(m[1]), { id: cleanText(m[2]), name: longName });
  }
  const outputs = [];
  for (const line of String(pcmText || '').split(/\r?\n/)) {
    const m = /^(\d+)-(\d+):\s*([^:]*):\s*([^:]*):(.*)$/.exec(line);
    if (!m || !/playback/i.test(m[5])) continue;
    const card = cards.get(Number(m[1]));
    if (!card) continue;
    const dev = Number(m[2]);
    const pcmName = cleanText(m[4]);
    const sameCard = String(pcmText).split(/\r?\n/).filter(l => l.startsWith(`${m[1]}-`) && /playback/i.test(l)).length > 1;
    outputs.push({
      id: `alsa:hw:CARD=${card.id},DEV=${dev}`,
      name: `${card.name}${sameCard ? ` (${pcmName})` : ''}`,
      description: `${card.name} -- direct hardware output`,
      state: 'unknown',
      server: 'ALSA (bit-perfect)',
      bitPerfect: true
    });
  }
  return outputs;
}

async function listAlsaBitPerfectOutputs() {
  try {
    const fs = require('fs/promises');
    const [cards, pcm] = await Promise.all([fs.readFile('/proc/asound/cards', 'utf8'), fs.readFile('/proc/asound/pcm', 'utf8')]);
    return parseAlsaPlaybackDevices(cards, pcm);
  } catch { return []; }
}

async function listPulseOutputs() {
  try {
    const result = await execFileAsync('pactl', ['-f', 'json', 'list', 'sinks'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const outputs = parsePactlJson(result.stdout);
    return { supported: true, outputs, defaultId: await getDefaultSink() };
  } catch (jsonError) {
    try {
      const result = await execFileAsync('pactl', ['list', 'short', 'sinks'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return { supported: true, outputs: parsePactlShort(result.stdout), defaultId: await getDefaultSink() };
    } catch (error) {
      const detail = `${error?.stderr || ''} ${error?.message || ''} ${jsonError?.message || ''}`;
      if (/not found|ENOENT/i.test(detail)) {
        return { supported: false, outputs: [], reason: 'PulseAudio/PipeWire audio tools (pactl) are not installed.' };
      }
      return { supported: false, outputs: [], reason: 'Hive could not enumerate the system audio outputs.' };
    }
  }
}

// The picker lists the system's outputs; bit-perfect is a separate toggle that
// maps the chosen output to its ALSA hardware device. Attach that mapping
// (alsaId) to every output that is a real sound-card device -- virtual sinks
// (EasyEffects, loopbacks, Bluetooth) have none and can't be bit-perfect.
async function readAsoundText() {
  const fs = require('fs/promises');
  try { return await Promise.all([fs.readFile('/proc/asound/cards', 'utf8'), fs.readFile('/proc/asound/pcm', 'utf8')]); }
  catch { return ['', '']; }
}
function attachAlsaIds(outputs, cardsText, pcmText) {
  const hw = parseAlsaPlaybackDevices(cardsText, pcmText);
  const byCardDev = new Map();
  for (const out of hw) {
    const m = /^alsa:hw:CARD=([^,]+),DEV=(\d+)$/.exec(out.id);
    const line = String(cardsText).split(/\r?\n/).find(l => new RegExp(`\\[${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`).test(l));
    const num = line ? Number(/^\s*(\d+)/.exec(line)[1]) : null;
    if (num !== null) byCardDev.set(`${num}:${m[2]}`, out.id);
  }
  return outputs.map(o => {
    const alsaId = o.alsaCard != null ? byCardDev.get(`${o.alsaCard}:${o.alsaDevice ?? 0}`) : undefined;
    return alsaId ? { ...o, alsaId } : o;
  });
}

async function listAudioOutputs() {
  if (process.platform !== 'linux') return { supported: false, outputs: [], reason: 'Audio output selection is currently supported on Linux.' };
  const [pulse, [cardsText, pcmText]] = await Promise.all([listPulseOutputs(), readAsoundText()]);
  if (!pulse.supported) return pulse;
  return { ...pulse, outputs: attachAlsaIds(pulse.outputs, cardsText, pcmText) };
}

// Turns the user's two choices (output + bit-perfect toggle) into the single
// device id the native helper opens. Returns { device, error? }.
async function effectiveOutputDevice(sink, bitPerfect) {
  const chosen = String(sink || '').trim();
  if (!bitPerfect) return { device: chosen };
  const { outputs, defaultId } = await listAudioOutputs();
  const target = (outputs || []).find(o => o.id === (chosen || defaultId));
  if (!target?.alsaId) {
    return { device: chosen, error: `${target?.name || 'This output'} isn't a hardware sound card (for example an effects app, loopback or Bluetooth device), so it can't be bit-perfect. Pick a DAC, headphone jack or HDMI output.` };
  }
  return { device: target.alsaId };
}

async function getDefaultSink() {
  try {
    const result = await execFileAsync('pactl', ['get-default-sink'], { timeout: 3000, maxBuffer: 64 * 1024 });
    return cleanText(result.stdout);
  } catch { return ''; }
}

// Decides what the native helper should actually open at launch. A bit-perfect
// (alsa:) output needs exclusive access to the card, but PipeWire keeps it open
// whenever any stream is on it -- and some apps (Discord's voice engine) keep a
// stream open permanently. Opening it anyway just fails ("Device is being used
// by another application") and playback goes silent. So check the kernel's view
// first (/proc/asound/cardN/pcmDp/sub0/status reads "closed" when free) and, if
// busy, fall back to the same DAC's normal PipeWire sink so music still plays.
function resolveLaunchOutput(deviceId, { readFile = require('fs').readFileSync, execFileSync = require('child_process').execFileSync } = {}) {
  const id = String(deviceId || '').trim();
  const m = /^alsa:hw:CARD=([^,]+),DEV=(\d+)$/.exec(id);
  if (!m) return { device: id, bitPerfect: false, fallback: false };
  const [, cardId, dev] = m;
  let cardNumber = null;
  try {
    const cards = readFile('/proc/asound/cards', 'utf8');
    const line = String(cards).split(/\r?\n/).find(l => new RegExp(`^\\s*\\d+\\s+\\[${cardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`).test(l));
    if (line) cardNumber = Number(/^\s*(\d+)/.exec(line)[1]);
  } catch {}
  if (cardNumber === null) return { device: '', bitPerfect: false, fallback: true, reason: 'The bit-perfect device is not connected; using the system default output.' };
  let status = '';
  try { status = String(readFile(`/proc/asound/card${cardNumber}/pcm${dev}p/sub0/status`, 'utf8')); } catch { status = ''; }
  if (/^\s*closed\s*$/m.test(status) || !status) {
    // Remember what PipeWire had before Hive takes the card, so it can be put
    // back when Hive lets go (see scheduleExclusiveReleaseRestore).
    const restore = { cardNumber };
    try { restore.previousDefault = String(execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8', timeout: 3000 })).trim(); } catch {}
    try {
      const cards = JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', 'cards'], { encoding: 'utf8', timeout: 3000 }));
      const card = (Array.isArray(cards) ? cards : []).find(c => String(c?.properties?.['api.alsa.card'] ?? c?.properties?.['alsa.card'] ?? '') === String(cardNumber));
      if (card?.name) { restore.cardName = String(card.name); restore.profile = String(card.active_profile || ''); }
    } catch {}
    return { device: id, bitPerfect: true, fallback: false, restore };
  }
  // Busy: find this card's PipeWire/Pulse sink and play through it (shared).
  let sharedSink = '';
  try {
    const sinks = JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', 'sinks'], { encoding: 'utf8', timeout: 3000 }));
    const match = (Array.isArray(sinks) ? sinks : []).find(sink => {
      const props = sink?.properties || {};
      return String(props['api.alsa.card'] ?? props['alsa.card'] ?? '') === String(cardNumber) &&
        String(props['alsa.device'] ?? props['api.alsa.pcm.device'] ?? dev) === String(dev);
    });
    sharedSink = String(match?.name || '');
  } catch {}
  return {
    device: sharedSink,
    bitPerfect: false,
    fallback: true,
    reason: `Bit-perfect output is unavailable: another app is using this device -- often an effects/EQ app such as EasyEffects that routes all audio through it, or a voice chat app like Discord. Playing through the shared system mixer instead. Quit or re-route that app so nothing else is using this device, then restart Hive.`
  };
}

// While Hive holds a card exclusively, PipeWire can fail to reopen it and drop
// that output entirely, moving the system default elsewhere -- and it doesn't
// bring either back when Hive lets go, leaving the whole desktop silent (seen
// with a Topping DX1). After Hive's helper exits, re-apply the card's profile
// if its output is missing, then restore the previous default output. Runs as
// a detached script so it still completes when Hive itself is quitting.
function scheduleExclusiveReleaseRestore(restore, { spawn = require('child_process').spawn } = {}) {
  if (!restore || !restore.cardName) return false;
  const script = [
    'sleep 0.5',
    'stem="$(printf %s "$1" | sed "s/^alsa_card\\./alsa_output./")"',
    'if ! pactl list short sinks | grep -qF "$stem"; then',
    '  pactl set-card-profile "$1" off; sleep 0.5',
    '  pactl set-card-profile "$1" "${2:-HiFi}"; sleep 1',
    'fi',
    'if [ -n "$3" ] && [ "$(pactl get-default-sink)" != "$3" ] && pactl list short sinks | grep -qF "$3"; then',
    '  pactl set-default-sink "$3"',
    'fi'
  ].join('\n');
  try {
    const child = spawn('sh', ['-c', script, 'hive-audio-restore', restore.cardName, restore.profile || '', restore.previousDefault || ''], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch { return false; }
}

module.exports = { listAudioOutputs, getDefaultSink, parsePactlJson, parsePactlShort, parseAlsaPlaybackDevices, attachAlsaIds, effectiveOutputDevice, resolveLaunchOutput, scheduleExclusiveReleaseRestore };
