'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const manager = require(path.join(root, 'app/main/audio-output-manager.js'));
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'app/main/gstreamer-bridge.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('audio output manager parses pactl JSON sinks into stable device records', () => {
  const result = manager.parsePactlJson(JSON.stringify([{ name:'alsa_output.pci-1', description:'Monitor Speakers', state:'RUNNING', properties:{} }, { name:'bluez_output.headset', description:'Headphones', state:'IDLE', properties:{} }]));
  assert.deepEqual(result.map(x => [x.id, x.name]), [['alsa_output.pci-1','Monitor Speakers'],['bluez_output.headset','Headphones']]);
});

test('audio output manager parses pactl short fallback', () => {
  const result = manager.parsePactlShort('42\talsa_output.pci-1\tMonitor Speakers\n43\tbluez_output.headset\tHeadphones\n');
  assert.deepEqual(result.map(x => x.id), ['alsa_output.pci-1','bluez_output.headset']);
});

test('selected output is passed to the native helper and applied through pulsesink', () => {
  assert.match(bridge, /HIVE_AUDIO_OUTPUT_DEVICE/);
  assert.match(native, /gst_element_factory_make\("pulsesink"/);
  assert.match(native, /g_object_set\(pulse_sink, "device", requested_output/);
  assert.match(main, /ipcMain\.handle\('audio-output:list'/);
  assert.match(main, /ipcMain\.handle\('audio-output:set'/);
});

test('audio output selector is exposed through preload and Playback settings', () => {
  assert.match(preload, /listAudioOutputs/);
  assert.match(preload, /setAudioOutput/);
  assert.match(html, /id="setting-audio-output"/);
  // Output changes apply live (no Apply button, no restart), and bit-perfect
  // is a visible toggle rather than a hidden entry in the device list.
  assert.match(html, /id="setting-bit-perfect"/);
  assert.doesNotMatch(html, /audio-output-apply-btn/);
  assert.match(renderer, /refreshAudioOutputs/);
  assert.match(renderer, /async function applyAudioOutputLive\(\)/);
  assert.doesNotMatch(renderer, /Restart Hive to route playback/);
});

test('bit-perfect outputs list each ALSA hardware playback device, skipping capture-only devices', () => {
  const { parseAlsaPlaybackDevices } = require('../app/main/audio-output-manager');
  const cards = [
    ' 0 [L313           ]: USB-Audio - Live Streamer CAM 313',
    '                      Sunplus IT Co Live Streamer CAM 313 at usb-0000:10:00.0-1.1, high speed',
    ' 5 [DX1            ]: USB-Audio - DX1',
    '                      Topping DX1 at usb-0000:0d:00.0-4, high speed',
    ' 7 [Audio          ]: USB-Audio - USB Audio',
    '                      Generic USB Audio at usb-0000:0d:00.0-5, high speed'
  ].join('\n');
  const pcm = [
    '00-00: USB Audio : USB Audio : capture 1',
    '05-00: USB Audio : USB Audio : playback 1',
    '07-00: USB Audio : USB Audio : playback 1 : capture 1',
    '07-01: USB Audio : USB Audio #1 : playback 1 : capture 1'
  ].join('\n');
  const outputs = parseAlsaPlaybackDevices(cards, pcm);
  assert.deepEqual(outputs.map(o => o.id), ['alsa:hw:CARD=DX1,DEV=0', 'alsa:hw:CARD=Audio,DEV=0', 'alsa:hw:CARD=Audio,DEV=1']);
  assert.equal(outputs[0].name, 'Topping DX1');
  assert.equal(outputs[1].name, 'Generic USB Audio (USB Audio)');
  assert.ok(outputs.every(o => o.bitPerfect));
});

test('the native helper opens alsa: outputs directly with no user-volume element or ReplayGain', () => {
  const native = fs.readFileSync(path.join(__dirname, '..', 'app', 'native', 'gstreamer-player.c'), 'utf8');
  assert.match(native, /g_str_has_prefix\(requested_output, "alsa:"\)/);
  assert.match(native, /gst_element_factory_make\("alsasink"/);
  assert.match(native, /user_volume_element = bit_perfect \? NULL/);
  assert.match(native, /if \(bit_perfect\) value = 1\.0;/);
});

test('bit-perfect output falls back to the same DAC\'s shared sink when another app holds the card', () => {
  const { resolveLaunchOutput } = require('../app/main/audio-output-manager');
  const cards = ' 5 [DX1            ]: USB-Audio - DX1\n                      Topping DX1 at usb-0000:0d:00.0-4, high speed\n';
  const sinks = JSON.stringify([
    { name: 'alsa_output.other', properties: { 'api.alsa.card': '2', 'alsa.device': '0' } },
    { name: 'alsa_output.usb-Topping_DX1-00.HiFi__Headphones__sink', properties: { 'api.alsa.card': '5', 'alsa.device': '0' } }
  ]);
  const fakeFs = status => (file) => {
    if (file === '/proc/asound/cards') return cards;
    if (file === '/proc/asound/card5/pcm0p/sub0/status') return status;
    throw new Error('ENOENT');
  };
  const execFileSync = () => sinks;

  const pactlFake = (cmd, args) => {
    if (args[0] === 'get-default-sink') return 'alsa_output.usb-Topping_DX1-00.HiFi__Headphones__sink\n';
    if (args.includes('cards')) return JSON.stringify([{ name: 'alsa_card.usb-Topping_DX1-00', active_profile: 'HiFi', properties: { 'api.alsa.card': '5' } }]);
    return sinks;
  };
  const free = resolveLaunchOutput('alsa:hw:CARD=DX1,DEV=0', { readFile: fakeFs('closed\n'), execFileSync: pactlFake });
  assert.equal(free.device, 'alsa:hw:CARD=DX1,DEV=0');
  assert.equal(free.bitPerfect, true);
  assert.deepEqual(free.restore, { cardNumber: 5, previousDefault: 'alsa_output.usb-Topping_DX1-00.HiFi__Headphones__sink', cardName: 'alsa_card.usb-Topping_DX1-00', profile: 'HiFi' });

  const busy = resolveLaunchOutput('alsa:hw:CARD=DX1,DEV=0', { readFile: fakeFs('state: RUNNING\nowner_pid   : 27685\n'), execFileSync });
  assert.equal(busy.device, 'alsa_output.usb-Topping_DX1-00.HiFi__Headphones__sink');
  assert.equal(busy.fallback, true);
  assert.match(busy.reason, /another app is using this device/);

  const missing = resolveLaunchOutput('alsa:hw:CARD=Gone,DEV=0', { readFile: fakeFs('closed\n'), execFileSync });
  assert.equal(missing.device, '');
  assert.equal(missing.fallback, true);

  assert.deepEqual(resolveLaunchOutput('some_pulse_sink'), { device: 'some_pulse_sink', bitPerfect: false, fallback: false });
});

test('releasing an exclusive card runs a detached restore with the card, profile and previous default as arguments', () => {
  const { scheduleExclusiveReleaseRestore } = require('../app/main/audio-output-manager');
  let call = null; let unrefd = false;
  const spawn = (cmd, args, opts) => { call = { cmd, args, opts }; return { unref() { unrefd = true; } }; };
  assert.equal(scheduleExclusiveReleaseRestore({ cardName: 'alsa_card.usb-Topping_DX1-00', profile: 'HiFi', previousDefault: 'dx1_sink' }, { spawn }), true);
  assert.equal(call.cmd, 'sh');
  assert.deepEqual(call.args.slice(2), ['hive-audio-restore', 'alsa_card.usb-Topping_DX1-00', 'HiFi', 'dx1_sink']);
  assert.equal(call.opts.detached, true);
  assert.ok(unrefd, 'must not keep Hive alive');
  assert.match(call.args[1], /set-card-profile "\$1" off/);
  assert.equal(scheduleExclusiveReleaseRestore(null, { spawn }), false);
});

test('the native helper quits on its own when Hive closes its stdin', () => {
  const native = fs.readFileSync(path.join(__dirname, '..', 'app', 'native', 'gstreamer-player.c'), 'utf8');
  const thread = native.slice(native.indexOf('static gpointer stdin_thread'), native.indexOf('int main('));
  assert.match(thread, /g_async_queue_push\(commands, g_strdup\("QUIT"\)\)/);
});
