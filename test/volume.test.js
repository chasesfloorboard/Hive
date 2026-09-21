'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

// Canonical, stable home for ordinary local-playback user-volume tests. Edit
// this file in place when the volume architecture legitimately changes —
// this subsystem previously had 5+ separate buildNNN test files each pinned
// to one build's literal source text, none of which caught that the
// "direct apply" design they all asserted (builds 248-258) never actually
// stopped the audible popping a real user reported when dragging the
// slider. See CHANGELOG.md builds 193/239/241/246-258 for the history.
//
// Current architecture: ordinary user volume is a real in-pipeline
// GStreamer "volume" element ("hive-user-volume") in its own audio-sink bin,
// immediately upstream of the real sink. Each slider input is applied directly
// to that element. There is deliberately no 10 ms ramp or controller source:
// Build 259's cubic ramp was user-tested and still left a subtle audible pop.
// The important latency fix remains the element's placement after playbin's
// internal queue. Startup and unmuting use the same direct setter.
//
// ReplayGain remains on its separate "hive-track-gain" element upstream in
// playbin's audio-filter chain.

function nativeBlock(startMarker, endMarker) {
  const start = native.indexOf(startMarker);
  const end = native.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `expected to find "${startMarker}" before "${endMarker}"`);
  return native.slice(start, end);
}

test('user volume sits in its own bin right before the real sink, not upstream with ReplayGain', () => {
  assert.match(native, /gst_element_factory_make\("volume", "hive-track-gain"\)/);
  assert.match(native, /gst_element_factory_make\("volume", "hive-user-volume"\)/);
  // hive-user-volume links directly to the real sink inside its own bin...
  assert.match(native, /gst_element_link\(user_volume_element, sink\)/);
  assert.match(native, /g_object_set\(player, "audio-sink", sink_bin, NULL\)/);
  // ...and ReplayGain's chain (audio-filter) no longer includes it.
  assert.match(native, /gst_element_link\(track_gain_element, spectrum\)/);
  assert.doesNotMatch(native, /gst_element_link_many\(track_gain_element, user_volume_element/);
  // The old design's marker: writing playbin's own "volume" property was how
  // ordinary user volume used to reach the sink. It no longer should.
  assert.doesNotMatch(native, /g_object_set\(player, "volume"/);
});

test('the user-volume element is driven by the latest native slider target, not every queued event', () => {
  assert.doesNotMatch(native, /gst_interpolation_control_source_new\(\)/);
  assert.doesNotMatch(native, /GST_INTERPOLATION_MODE_(?:LINEAR|CUBIC_MONOTONIC)/);
  assert.doesNotMatch(native, /gst_direct_control_binding_new/);
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.match(block, /latest_volume\s*=\s*requested_volume/);
  assert.match(block, /pending_volume\s*=\s*TRUE/);
  assert.doesNotMatch(block, /set_user_volume\(requested_volume\)/);
  assert.match(native, /if \(pending_volume\)/);
  assert.match(native, /set_user_volume\(requested_volume\)/);
});

test('a slider-driven VOLUME command applies immediately, unless muted', () => {
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.match(block, /requested_volume\s*=\s*CLAMP/);
  assert.match(block, /latest_volume\s*=\s*requested_volume/);
  assert.match(block, /pending_volume\s*=\s*TRUE/);
  assert.doesNotMatch(block, /set_user_volume\(requested_volume\)/);
});

test('native command delivery wakes GStreamer immediately instead of polling every 5 ms', () => {
  assert.match(native, /g_main_context_invoke\(NULL, command_tick, NULL\)/);
  assert.match(native, /command_dispatch_pending/);
  assert.doesNotMatch(native, /g_timeout_add\(5, command_tick/);
});

test('transport commands never touch user volume', () => {
  const transport = nativeBlock('} else if (!g_strcmp0(parts[0], "PLAY")', '} else if (!g_strcmp0(parts[0], "SEEKPLAY")');
  assert.doesNotMatch(transport, /VOLUME/);
  assert.doesNotMatch(transport, /set_user_volume/);
});

test('unmuting snaps directly to the correct volume instead of fading in', () => {
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "MUTE") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "TRACE")');
  assert.match(block, /apply_output_mute\(TRUE\)/);
  assert.match(block, /set_user_volume\(user_volume\)/);
  assert.doesNotMatch(block, /ramp_user_volume_to|HIVE_USER_VOLUME_RAMP_NS/);
});

test('no manual GstStreamVolume element-walking or sink-volume routing experiment reappears', () => {
  // These historical mechanisms (builds 222/227) were reverted for being
  // fragile. Keep the dedicated in-pipeline element, but do not rediscover
  // sink-owned volume by walking playbin internals.
  assert.doesNotMatch(native, /deep-element-added|deep-element-removed/);
  assert.doesNotMatch(native, /GST_IS_STREAM_VOLUME/);
  assert.doesNotMatch(native, /#include <gst\/audio\/streamvolume\.h>/);
});

test('playbin\'s own soft-volume flag stays cleared and ReplayGain stays on its own element', () => {
  assert.match(native, /playbin_flags\s*&=\s*~HIVE_PLAY_FLAG_SOFT_VOLUME/);
  assert.match(native, /g_object_set\(player, "flags", playbin_flags, NULL\)/);
  assert.match(native, /apply_track_gain\(track_gain\)/);
});

test('renderer volume input stays immediate with no debounce timer and no duplicate pointerup write', () => {
  const start = renderer.indexOf("el.pbVolume.addEventListener('input'");
  const end = renderer.indexOf('// Allow the mouse wheel', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /audioEngine\.volume\s*=\s*value/);
  assert.match(block, /scheduleVolumePersistence\(\)/);
  assert.doesNotMatch(renderer, /nativeVolumeDispatchTimer|nativeVolumeDispatchPending|NATIVE_VOLUME_DISPATCH_MS/);
  const finish = renderer.slice(renderer.indexOf('const finishVolumePointer'), renderer.indexOf('el.pbVolume.addEventListener(\'pointerup\'', renderer.indexOf('const finishVolumePointer')));
  assert.doesNotMatch(finish, /setNativeVolumeImmediate/);
});

test('every VOLUME command records the applied target in the native trace', () => {
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.match(native, /snprintf\(detail, sizeof\(detail\), "value=%\.6f muted=%d stream_volume=hive-user-volume"/);
  assert.match(native, /trace_line\("VOLUME_STATE", detail\)/);
});

test('muted volume changes update the stored target without touching the output element', () => {
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.match(block, /latest_volume\s*=\s*requested_volume/);
  assert.match(native, /if \(pending_volume\) \{/);
});

test('one event-driven command callback drains the queued burst instead of scheduling one callback per command', () => {
  const dispatch = nativeBlock('static void *stdin_thread(void *unused) {', 'int main(int argc, char **argv) {');
  assert.match(dispatch, /g_async_queue_push\(commands, g_strdup\(line\)\)/);
  assert.match(dispatch, /g_atomic_int_compare_and_exchange\(&command_dispatch_pending, 0, 1\)/);
  assert.match(dispatch, /g_main_context_invoke\(NULL, command_tick, NULL\)/);
  const tick = nativeBlock('static gboolean command_tick(gpointer unused) {', 'static void *stdin_thread(void *unused) {');
  assert.match(tick, /while \(\(line = g_async_queue_try_pop\(commands\)\) != NULL\)/);
});

test('VOLUME bursts are applied once after the command queue drains', () => {
  const tick = nativeBlock('static gboolean command_tick(gpointer unused) {', 'static void *stdin_thread(void *unused) {');
  const drainEnd = tick.indexOf('if (pending_volume) {');
  assert.ok(drainEnd > 0);
  const drain = tick.slice(0, drainEnd);
  assert.match(drain, /while \(\(line = g_async_queue_try_pop\(commands\)\) != NULL\)/);
  assert.match(drain, /latest_volume\s*=\s*requested_volume/);
  assert.doesNotMatch(drain, /set_user_volume\(requested_volume\)/);
  const apply = tick.slice(drainEnd);
  assert.match(apply, /set_user_volume\(requested_volume\)/);
});

test('user-volume initialization happens before the sink bin is handed to playbin', () => {
  const sinkBlock = nativeBlock('GstElement *sink_bin = gst_bin_new("hive-audio-sink");', '/* Keep ReplayGain and visualization');
  const setIndex = sinkBlock.indexOf('g_object_set(G_OBJECT(user_volume_element), "volume", user_volume, NULL);');
  const playbinIndex = sinkBlock.indexOf('g_object_set(player, "audio-sink", sink_bin, NULL);');
  assert.ok(setIndex >= 0 && playbinIndex > setIndex, 'initial user volume should be set before assigning the sink bin to playbin');
});

// Moved here from build211-love-validator-volume.test.js (consolidated into
// test/love-metadata.test.js) -- this specific test was about the volume
// slider's own input path, not Love, and belongs in the one stable volume
// file rather than either.
test('local volume stays on the direct native audio path, with no rAF-batched pending-volume flush', () => {
  const start = renderer.indexOf("el.pbVolume.addEventListener('input'");
  const end = renderer.indexOf('// Allow the mouse wheel', start);
  assert.ok(start >= 0 && end > start, 'volume input handler must exist');
  const block = renderer.slice(start, end);
  assert.doesNotMatch(renderer, /pendingNativeVolume/);
  assert.doesNotMatch(renderer, /nativeVolumeRaf/);
  assert.match(block, /audioEngine\.volume\s*=\s*value/);
  assert.match(renderer, /setPointerCapture\(e\.pointerId\)/);
  assert.match(renderer, /el\.pbVolume\.addEventListener\('pointercancel', finishVolumePointer\)/);
  assert.doesNotMatch(renderer, /requestAnimationFrame\(flushNativeVolume\)/);
  assert.match(renderer, /pointercancel/);
  assert.match(renderer, /pointerup.*flushVolumePersistence/s);
});

