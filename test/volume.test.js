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
// immediately upstream of the real sink. Builds 259-260 tried ramping this
// element (linear, then cubic-monotonic, via GstController) and reverted
// both as "subtly audible" -- but those sessions ran in a sandboxed
// container with no real audio hardware to actually validate that claim on
// (see CLAUDE.md). The important latency fix remains the element's placement
// after playbin's internal queue. Startup, unmuting, and transport
// transitions all still use the direct (unramped) setter.
//
// The slider ramp itself went through two more iterations after that,
// BOTH validated against real hardware/ears this time (not sandboxed):
// 1. A GstPadProbe-driven ramp that set the element's "volume" property once
//    per buffer -- fixed the original external-timer version's wasted writes
//    (see the buffer-boundary-quantization test below), but pops were STILL
//    audible on real hardware.
// 2. Root cause: setting the property once per buffer makes every sample
//    WITHIN that buffer share one flat gain -- a staircase with as many
//    steps as there are buffers in the ramp window, which decoders handing
//    off large frames (a FLAC block can be ~90ms) can reduce to a single
//    step, indistinguishable from an instant jump. Fixed by ramping at the
//    SAMPLE level: while a ramp is active, the element's own property is
//    forced to a 1.0 pass-through and volume_ramp_probe_cb applies a
//    smoothly interpolated gain directly to each buffer's raw PCM samples
//    (see apply_sample_ramp), continuous regardless of buffer size. The
//    property becomes authoritative again the instant the ramp ends.
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
  // Still no GstController -- the ramp is a plain self-terminating GLib
  // timeout (see begin_user_volume_ramp), not a controller/interpolation
  // source. That historical mechanism class remains rejected.
  assert.doesNotMatch(native, /gst_interpolation_control_source_new\(\)/);
  assert.doesNotMatch(native, /GST_INTERPOLATION_MODE_(?:LINEAR|CUBIC_MONOTONIC)/);
  assert.doesNotMatch(native, /gst_direct_control_binding_new/);
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.match(block, /latest_volume\s*=\s*requested_volume/);
  assert.match(block, /pending_volume\s*=\s*TRUE/);
  assert.doesNotMatch(block, /set_user_volume\(requested_volume\)/);
  assert.match(native, /if \(pending_volume\)/);
  assert.match(native, /begin_user_volume_ramp\(requested_volume\)/);
});

test('a slider-driven VOLUME command starts a retargeting ramp while playing, unless muted', () => {
  const block = nativeBlock('} else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {', '} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.match(block, /requested_volume\s*=\s*CLAMP/);
  assert.match(block, /latest_volume\s*=\s*requested_volume/);
  assert.match(block, /pending_volume\s*=\s*TRUE/);
  assert.doesNotMatch(block, /set_user_volume\(requested_volume\)/);
  const apply = nativeBlock('if (pending_volume) {', 'return G_SOURCE_CONTINUE;');
  assert.match(apply, /if \(playing_state\) begin_user_volume_ramp\(requested_volume\);/);
  assert.match(apply, /else \{ cancel_user_volume_ramp\(\); user_volume = requested_volume; \}/);
});

// Real bug, confirmed by the user: the ramp is interpolated entirely from
// inside a GstPadProbe on the volume element's sink pad (see the buffer-probe
// test above), which only ever fires while buffers are actively flowing.
// While paused, nothing flows, so a ramp started here sat inert -- the
// requested volume silently never took effect until the user pressed Play
// again. Since there's no audio playing (nothing to pop) while paused, the
// fix applies the change directly instead of ramping.
test('a VOLUME command applies immediately while paused/stopped, instead of starting an inert ramp', () => {
  const apply = nativeBlock('if (pending_volume) {', 'return G_SOURCE_CONTINUE;');
  assert.match(apply, /if \(playing_state\) begin_user_volume_ramp\(requested_volume\);\s*\n\s*else \{ cancel_user_volume_ramp\(\); set_user_volume\(requested_volume\); \}/);
});

// The ramp retargets in place instead of restarting: a new VOLUME command
// mid-ramp takes the CURRENT (already-interpolated) volume as its new start
// point, not the original pre-drag value. This is what keeps a fast slider
// drag smooth instead of stacking or restarting overlapping ramps.
//
// A rate-limited variant (skipping the start_time/anchor reset for retargets
// closer together than ~12ms) was tried and reverted: confirmed live, it
// made fast-drag popping WORSE, not better. During a sustained fast drag
// (commands arriving faster than the rate limit, continuously), the anchor
// never got refreshed at all -- it just aged while the target kept moving,
// so once more than 50ms had passed since that now-stale anchor, every
// buffer saw "elapsed >= VOLUME_RAMP_DURATION_US" and snapped instantly to
// whatever the target happened to be at that moment, repeatedly, for as
// long as the fast drag continued. Always refreshing the anchor on every
// retarget (unconditionally, as tested here) is what keeps the ramp from
// ever going stale relative to a moving target.
test('the volume ramp retargets in place from wherever it currently is, unconditionally on every command', () => {
  const fn = nativeBlock('static void begin_user_volume_ramp(gdouble target) {', '\n}');
  assert.match(fn, /volume_ramp_start = user_volume;/);
  assert.match(fn, /volume_ramp_target = target;/);
  assert.match(fn, /volume_ramp_started_at = g_get_monotonic_time\(\);/);
  assert.match(fn, /volume_ramp_active = TRUE;/);
  assert.doesNotMatch(native, /VOLUME_RAMP_MIN_RETARGET_INTERVAL_US/, 'the rate-limited retargeting variant must not reappear -- see the comment above for why it was reverted');
});

// Real bug, confirmed by ear: an earlier version of this ramp used an
// external g_timeout_add() wall-clock timer. GStreamer's "volume" element
// only actually picks up a new property value when it next processes a
// buffer, on the pipeline's own buffer/period cadence -- completely
// decoupled from an external timer. A 500ms ramp ticking every 8ms (~62
// writes) was only heard as ~5 discrete pops: most writes were silently
// overwritten before ever reaching a real buffer. Driving the ramp from
// inside a pad probe on the element's own sink pad instead means every
// buffer that is actually processed gets a correctly-timed value, with no
// race against buffer boundaries and no wasted writes.
test('the ramp is driven from inside a buffer probe on the volume element\'s own sink pad, not an external timer', () => {
  assert.doesNotMatch(native, /g_timeout_add\(VOLUME_RAMP_TICK_MS/);
  const probe = nativeBlock('static GstPadProbeReturn volume_ramp_probe_cb(GstPad *pad, GstPadProbeInfo *info, gpointer unused) {', 'static void begin_user_volume_ramp');
  assert.match(probe, /if \(!volume_ramp_active\) return GST_PAD_PROBE_OK;/);
  assert.match(probe, /GstBuffer \*buffer = GST_PAD_PROBE_INFO_BUFFER\(info\);/);
  assert.match(probe, /if \(finishing\) \{/);
  assert.match(probe, /volume_ramp_active = FALSE;/);
  assert.match(probe, /set_user_volume\(volume_ramp_target\);/);
  assert.match(native, /gst_pad_add_probe\(sink_pad, GST_PAD_PROBE_TYPE_BUFFER, volume_ramp_probe_cb, NULL, NULL\);/);
});

// Real bug, confirmed by ear on real hardware: even with the buffer-probe
// fix above, pops were still audible. Root cause: the element's "volume"
// property was set once per buffer, so every sample WITHIN a buffer shared
// one flat gain -- a staircase with as many steps as there are buffers in
// the ramp window, which a decoder handing off large frames (a FLAC block
// can be ~90ms) can reduce to a single step, indistinguishable from an
// instant jump. Fixed by ramping at the sample level instead.
// Real bug found via threading analysis, same day as the finish-side
// double-apply fix above: begin_user_volume_ramp() runs on the MAIN thread
// (via command_tick's g_main_context_invoke), a different thread than
// volume_ramp_probe_cb, which runs on GStreamer's streaming thread. Forcing
// the element's "volume" property to 1.0 directly from begin_user_volume_ramp
// had no ordering guarantee relative to the streaming thread: a buffer's
// probe call could read volume_ramp_active as still-stale FALSE (so it
// passed through untouched) while that SAME buffer's chain() call, racing
// concurrently, could read the property AFTER it was already forced to
// 1.0 -- a brief real jump to unscaled full volume, heard as a small pop
// right as a ramp starts. Fixed the same way as the finish-side bug: defer
// the force into the probe itself (volume_ramp_pending_start), so the
// property write and that buffer's sample-scaling always happen together,
// on the same thread, for the same buffer.
test('an active ramp forces the element to a 1.0 pass-through and applies gain directly to samples, not the property', () => {
  const beginFn = nativeBlock('static void begin_user_volume_ramp(gdouble target) {', '\n}');
  assert.match(beginFn, /volume_ramp_pending_start = TRUE;/);
  assert.doesNotMatch(beginFn, /g_object_set\(G_OBJECT\(user_volume_element\), "volume", 1\.0, NULL\);/, 'the property must not be forced from the main thread -- see volume_ramp_pending_start');

  const probe = nativeBlock('static GstPadProbeReturn volume_ramp_probe_cb(GstPad *pad, GstPadProbeInfo *info, gpointer unused) {', 'static void begin_user_volume_ramp');
  assert.match(probe, /if \(volume_ramp_pending_start\) \{\s*\n\s*volume_ramp_pending_start = FALSE;\s*\n\s*if \(user_volume_element\) g_object_set\(G_OBJECT\(user_volume_element\), "volume", 1\.0, NULL\);/);
  assert.match(probe, /buffer = gst_buffer_make_writable\(buffer\);/);
  assert.match(probe, /GST_PAD_PROBE_INFO_DATA\(info\) = buffer;/);
  assert.match(probe, /apply_sample_ramp\(buffer, &ramp_audio_info, start_gain, end_gain\)/);
});

test('cancelling a ramp also clears any pending start-force so a late/cancelled ramp cannot still force pass-through', () => {
  const cancel = nativeBlock('static void cancel_user_volume_ramp(void) {', 'static gboolean ensure_ramp_audio_info');
  assert.match(cancel, /volume_ramp_pending_start = FALSE;/);
});

test('apply_sample_ramp interpolates gain per-sample across the buffer, and only for known-safe interleaved PCM formats', () => {
  const fn = nativeBlock('static gboolean apply_sample_ramp(GstBuffer *buffer, const GstAudioInfo *info, gdouble start_gain, gdouble end_gain) {', '\n}');
  // Bounded to the exact formats GStreamer's own "volume" element supports --
  // anything else is rejected (returns FALSE) rather than risking scaling
  // the wrong bytes of an unknown layout.
  for (const fmt of ['GST_AUDIO_FORMAT_S16', 'GST_AUDIO_FORMAT_S32', 'GST_AUDIO_FORMAT_F32', 'GST_AUDIO_FORMAT_F64']) {
    assert.match(fn, new RegExp(`case ${fmt}:`));
  }
  assert.match(fn, /gst_buffer_map\(buffer, &map, GST_MAP_READWRITE\)/);
  // The gain at each frame is interpolated between start_gain and end_gain
  // across the buffer's own frame count -- a real per-sample ramp, not one
  // flat multiplier for the whole buffer.
  assert.match(fn, /const gdouble gain = start_gain \+ \(end_gain - start_gain\) \* t;/);
  assert.match(fn, /gst_buffer_unmap\(buffer, &map\);/);
});

test('ensure_ramp_audio_info rejects a non-interleaved layout rather than risk scaling the wrong bytes', () => {
  const fn = nativeBlock('static gboolean ensure_ramp_audio_info(GstPad *pad) {', '\n}');
  assert.match(fn, /GST_AUDIO_INFO_LAYOUT\(&info\) == GST_AUDIO_LAYOUT_INTERLEAVED/);
  // Caps are cached and cheaply compared so this is safe to call every buffer.
  assert.match(fn, /gst_caps_is_equal\(ramp_cached_caps, caps\)/);
});

test('a sample-ramp mapping failure falls back to the property step for that buffer instead of leaving audio at the forced 1.0 pass-through', () => {
  const probe = nativeBlock('static GstPadProbeReturn volume_ramp_probe_cb(GstPad *pad, GstPadProbeInfo *info, gpointer unused) {', 'static void begin_user_volume_ramp');
  const ifStart = probe.indexOf('if (apply_sample_ramp(buffer, &ramp_audio_info, start_gain, end_gain)) {');
  assert.ok(ifStart >= 0);
  const elseBlock = probe.slice(ifStart, probe.indexOf('}', probe.indexOf('} else {', ifStart) + 8) + 1);
  assert.match(elseBlock, /set_user_volume\(end_gain\);/);
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

// Builds 222/227 tried discovering the real sink dynamically by walking
// playbin's internals via the "deep-element-added"/"deep-element-removed"
// signals, and casting it to GstStreamVolume -- reverted for being fragile,
// since it depends on playbin's internal element graph and signal timing.
// That specific mechanism remains rejected.
//
// This session ALSO tried routing volume through the real sink's own
// native "volume"/"mute" properties directly (pulsesink exposes these; no
// element-walking needed since this app creates `sink` itself and already
// holds a reference to it) -- the theory being that PulseAudio/PipeWire's
// own audio-server mixing stage would smooth the change the same way it
// does for the OS's own volume control, the way real GStreamer media
// players like Rhythmbox do. Tried and reverted: confirmed live, on real
// hardware, that assumption did not hold for at least this PipeWire setup.
// Routing there meant begin_user_volume_ramp() skipped ramping entirely,
// so a single big jump (e.g. 100% down to 14%) became a real, completely
// unramped instant change -- worse than what it replaced, not better.
// hive-user-volume's own sample-level ramp is the sole mechanism again: it
// doesn't depend on any assumption about how the sink/audio server
// internally handles a property write, since it controls the real audio
// samples directly.
test('no sink-volume routing (element-walking OR direct native-property delegation) reappears', () => {
  assert.doesNotMatch(native, /deep-element-added|deep-element-removed/);
  assert.doesNotMatch(native, /GST_IS_STREAM_VOLUME/);
  assert.doesNotMatch(native, /#include <gst\/audio\/streamvolume\.h>/);
  assert.doesNotMatch(native, /native_volume_sink/);
  assert.doesNotMatch(native, /sink_has_native_volume/);
  assert.doesNotMatch(native, /g_object_class_find_property\(G_OBJECT_GET_CLASS\(sink\)/);
});

// Real bug found via live diagnostic testing: a GstPadProbe on a sink pad
// runs BEFORE the element's own chain() function processes that same
// buffer. A finishing ramp used to restore the element's "volume" property
// to the target gain in the SAME probe call where that buffer's samples had
// just been manually scaled to that same target -- so the element then
// applied the gain a SECOND time to already-correctly-scaled samples,
// squaring the effective gain (worst for low targets/fast drags, matching
// exactly what the user reported: "100 to 14 percent... or drag it up and
// down really fast"). Fixed by deferring the property restore to the START
// of the NEXT probe invocation (guaranteed to be a different, not-yet-
// processed buffer) via volume_ramp_pending_restore.
test('a finishing ramp defers its property restore to the next buffer instead of double-applying gain on the same one', () => {
  const probe = nativeBlock('static GstPadProbeReturn volume_ramp_probe_cb(GstPad *pad, GstPadProbeInfo *info, gpointer unused) {', 'static void begin_user_volume_ramp');
  assert.match(probe, /if \(volume_ramp_pending_restore\) \{/);
  assert.match(probe, /volume_ramp_pending_restore = FALSE;\s*\n\s*set_user_volume\(volume_ramp_target\);/);
  const finishBlock = probe.slice(probe.indexOf('if (finishing) {'));
  assert.doesNotMatch(finishBlock.slice(0, finishBlock.indexOf('}')), /set_user_volume\(volume_ramp_target\)/, 'the finishing branch must not restore the property on the same buffer whose samples it just scaled');
  assert.match(finishBlock, /volume_ramp_pending_restore = TRUE;/);
  assert.doesNotMatch(native, /RAMP_BUFFER_DIAG/, 'the temporary diagnostic that found this bug should be removed once the fix landed');
});

test('cancelling or retargeting a ramp clears any pending deferred restore so it cannot clobber a later ramp', () => {
  const cancel = nativeBlock('static void cancel_user_volume_ramp(void) {', 'static gboolean ensure_ramp_audio_info');
  assert.match(cancel, /volume_ramp_pending_restore = FALSE;/);
  const begin = nativeBlock('static void begin_user_volume_ramp(gdouble target) {', 'static void apply_track_gain');
  assert.match(begin, /volume_ramp_pending_restore = FALSE;/);
});

// Real bug the user reported directly: with no explicit "volume"/"mute"
// write on the actual output sink at startup, PipeWire's session manager
// assigns a brand-new stream whatever its own default is (observed on the
// user's desktop: 50%, not 100%) -- so the OS mixer/sound-settings entry for
// this app was misleading even while hive-user-volume, the sole real gain
// control, sat at unity. Fixed by explicitly forcing the sink's own stream
// volume/mute to unity/unmuted once at pipeline startup. This is NOT the
// same as the rejected native-sink-volume-ROUTING pattern above -- that was
// about running the user's continuous slider changes through the sink's
// property; this is a one-time startup pin so the system mixer always
// reflects 100% while hive-user-volume keeps doing all the real work.
test('the real output sink is pinned to unity volume/unmuted once at startup, independent of PipeWire/WirePlumber stream defaults', () => {
  assert.match(native, /gboolean sink_is_pulse = FALSE;/);
  assert.match(native, /if \(sink_is_pulse\) g_object_set\(sink, "volume", 1\.0, "mute", FALSE, NULL\);/);
  // Must not resurrect the rejected element-walking/introspection pattern
  // that the routing-revert test above guards against.
  assert.doesNotMatch(native, /g_object_class_find_property/);
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
  assert.match(native, /snprintf\(detail, sizeof\(detail\), "value=%\.6f muted=%d stream_volume=hive-user-volume ramp=\d+ms"/);
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
  assert.match(apply, /begin_user_volume_ramp\(requested_volume\)/);
});

test('user-volume initialization happens before the sink bin is handed to playbin', () => {
  const sinkBlock = nativeBlock('GstElement *sink_bin = gst_bin_new("hive-audio-sink");', '/* Keep ReplayGain and visualization');
  const setIndex = sinkBlock.indexOf('g_object_set(G_OBJECT(user_volume_element), "volume", user_volume, NULL);');
  const playbinIndex = sinkBlock.indexOf('g_object_set(player, "audio-sink", sink_bin, NULL);');
  assert.ok(setIndex >= 0 && playbinIndex > setIndex, 'initial user volume should be set before assigning the sink bin to playbin');
});

// Moved here from build151-volume-unmute-safety.test.js during the #12
// buildNNN consolidation pass -- still-accurate coverage of a real safety
// gate, just filed under the wrong (build-numbered) home.
test('an early MUTE=0 cannot make the pipeline audible before STREAM_START+PLAYING', () => {
  const start = native.indexOf('} else if (!g_strcmp0(parts[0], "MUTE")');
  const end = native.indexOf('\n      } else if (!g_strcmp0(parts[0], "QUIT")', start + 20);
  const block = native.slice(start, end > start ? end : start + 1400);
  assert.match(block, /stream_started && playing_state/);
  assert.match(block, /MUTE_DEFERRED|defer/i);
  const stateChangeStart = native.indexOf('if (new_s == GST_STATE_PLAYING)');
  const stateChangeBlock = native.slice(stateChangeStart, stateChangeStart + 600);
  assert.match(stateChangeBlock, /if \(stream_started && !user_muted\)/);
});

test('slider volume movement alone cannot turn a failed/stalled native stream back into audible output', () => {
  const start = renderer.indexOf("el.pbVolume.addEventListener('input'");
  const end = renderer.indexOf('// Allow the mouse wheel', start);
  const block = renderer.slice(start, end);
  assert.match(block, /audioEngine\.volume = value/);
  assert.doesNotMatch(block, /audioEngine\.muted\s*=\s*false/);
  assert.doesNotMatch(block, /audio\.volume = value/);
});

// Moved here from build214/build215 (build215 superseded build214's cubic
// mapping with a direct linear one; both files asserted the same surviving
// behavior, so only one merged test is kept) and build253/build241 (the
// renderer's immediate-apply, no-debounce-timer path for local slider input).
test('the visible slider percentage projects directly to/from canonical linear engine volume, with no cubic mapping and no dispatch timer', () => {
  assert.doesNotMatch(renderer, /function volumeSliderToEngine/);
  assert.doesNotMatch(renderer, /function engineVolumeToSlider/);
  assert.doesNotMatch(renderer, /Math\.cbrt/);
  assert.match(renderer, /function renderVolumeSliderFromEngine\(engineValue\) \{/);
  const fnStart = renderer.indexOf('function renderVolumeSliderFromEngine(engineValue) {');
  const fnEnd = renderer.indexOf('\n  }', fnStart) + 4;
  assert.match(renderer.slice(fnStart, fnEnd), /Math\.round\(clampUnitVolume\(engineValue\)\s*\*\s*100\)/);
  assert.match(renderer, /function setNativeVolumeImmediate\(/);
  assert.doesNotMatch(renderer, /nativeVolumeDispatchTimer|nativeVolumeDispatchPending|NATIVE_VOLUME_DISPATCH_MS|nativeVolumePending/);
});

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

