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
    return name ? {
      id: name,
      name: description,
      description,
      state: cleanText(sink?.state, 'unknown'),
      server: 'PulseAudio/PipeWire compatibility'
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

async function listAudioOutputs() {
  if (process.platform !== 'linux') return { supported: false, outputs: [], reason: 'Audio output selection is currently supported on Linux.' };
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

async function getDefaultSink() {
  try {
    const result = await execFileAsync('pactl', ['get-default-sink'], { timeout: 3000, maxBuffer: 64 * 1024 });
    return cleanText(result.stdout);
  } catch { return ''; }
}

module.exports = { listAudioOutputs, getDefaultSink, parsePactlJson, parsePactlShort };
