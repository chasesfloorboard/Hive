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
  assert.match(html, /audio-output-apply-btn/);
  assert.match(renderer, /refreshAudioOutputs/);
  assert.match(renderer, /Restart Hive to route playback/);
});
