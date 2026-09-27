/* Beehive GStreamer backend.
 *
 * GStreamer owns the complete playback pipeline, clock, buffering, decoding,
 * audio output, seeking, and gapless next-track transition.  The Electron
 * renderer only sends transport commands and receives lightweight state
 * events; PCM is never copied through Electron IPC.
 */
#include <gst/gst.h>
#include <gst/audio/audio.h>
#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#ifdef G_OS_WIN32
#include <fcntl.h>
#include <io.h>
#endif

/* GstPlayFlags belongs to the playbin plugin API rather than the GStreamer
 * core headers. GStreamer documents soft-volume as bit 0x10, but the enum
 * constant is not exported by gst/gst.h. Keep the value local instead of
 * depending on a plugin-only header symbol. */
static const gint HIVE_PLAY_FLAG_SOFT_VOLUME = (1 << 4);

static GstElement *player = NULL;
static GMainLoop *loop = NULL;
static GAsyncQueue *commands = NULL;
static volatile gint command_dispatch_pending = 0;
static GMutex next_lock;
static gchar *next_uri = NULL;
static FILE *event_fp = NULL;
static gboolean shutting_down = FALSE;
static gdouble trim_start = 0.0;
static gdouble trim_end = 0.0;
static gboolean trim_end_emitted = FALSE;
static gboolean stream_started = FALSE;
static gboolean playing_state = FALSE;
static gboolean user_muted = FALSE;
static gboolean trace_enabled = FALSE;
static gdouble track_gain = 1.0; /* optional ReplayGain multiplier for the current track */
static gdouble user_volume = 0.8; /* explicit 0-1 user slider value */
/* Bit-perfect output: HIVE_AUDIO_OUTPUT_DEVICE="alsa:<device>" opens that ALSA
 * hardware device directly (bypassing PipeWire's mixer/resampler) and leaves
 * every sample untouched -- no user-volume element and no ReplayGain. Volume is
 * then the DAC's job; MUTE still works through playbin. */
static gboolean bit_perfect = FALSE;
static GstElement *spectrum = NULL;
static GstElement *track_gain_element = NULL;
static GstElement *user_volume_element = NULL;
static GstElement *audio_filter_bin = NULL;
/* Real dead end, confirmed live: this used to also route volume through the
 * real sink's own native "volume"/"mute" properties (pulsesink exposes
 * these directly) when available, on the theory that PulseAudio/PipeWire's
 * own audio-server mixing stage would smooth the change the same way it
 * does for the OS's own volume control -- what real GStreamer media
 * players like Rhythmbox do. Confirmed NOT true for at least this PipeWire
 * setup: routing there means begin_user_volume_ramp() skipped ramping
 * entirely (assuming the server would smooth it), which made a single big
 * jump (e.g. 100% down to 14%) an actual instant, completely unramped
 * change -- a real, confirmed regression, not an improvement. Reverted.
 * hive-user-volume's own sample-level ramp (below) is the sole mechanism
 * again: it doesn't depend on any assumption about how the sink or audio
 * server internally handles a property write, since it controls the real
 * audio samples directly. */

/* Ordinary user-volume slider changes are ramped to the new target over
 * VOLUME_RAMP_DURATION_US instead of jumping instantly, to avoid the audible
 * step discontinuity a large instant gain change produces. This is
 * deliberately scoped to the ordinary slider path only -- unmute, startup,
 * and every other caller of set_user_volume() still snaps immediately (see
 * their call sites below), matching the long-established rule that only
 * explicit user volume movement should ever be smoothed.
 *
 * An earlier version of this ramp used an external g_timeout_add() wall-clock
 * timer ticking every 8ms. That measured out to ~62 property writes over a
 * 500ms ramp, but the user still heard only ~5 discrete pops -- because
 * GStreamer's "volume" element only picks up a new property value when it
 * next processes an audio buffer, and that happens on the pipeline's own
 * buffer/period cadence (commonly ~100ms), completely decoupled from an
 * external wall-clock timer. Roughly 57 of those 62 writes were silently
 * overwritten before ever reaching an actual buffer, leaving only a handful
 * of larger, still-abrupt jumps -- the pops the timer approach was supposed
 * to eliminate. Interpolating from *inside* a buffer probe on the element's
 * own sink pad instead means every single buffer that is actually processed
 * gets exactly the right value for its timestamp, with zero wasted writes and
 * no race against buffer boundaries.
 *
 * A prior linear/cubic GstController-based ramp was tried and reverted across
 * builds 259-260 after remaining "subtly audible" on real hardware, but those
 * sessions ran in a sandboxed container that never had real audio hardware to
 * actually hear it on (see CLAUDE.md).
 *
 * Real bug, confirmed live on real hardware this time: even with the
 * buffer-probe fix above, pops were still audible. Root cause: setting the
 * element's "volume" property once per buffer makes every sample WITHIN that
 * buffer share one flat gain value -- the "ramp" is really a staircase with
 * as many steps as there are buffers in the 50ms window. Decoders commonly
 * hand off one whole decoded frame per buffer (a single FLAC block can be
 * ~90ms of audio), which can make that staircase have only one step --
 * indistinguishable from an instant jump. Fixed by ramping at the sample
 * level instead: while a ramp is active, the element's own property is
 * forced to a 1.0 pass-through and volume_ramp_probe_cb applies a smoothly
 * interpolated gain directly to each buffer's raw PCM samples (see
 * apply_sample_ramp), so the curve is continuous regardless of how large or
 * small the incoming buffers are. The element's property becomes
 * authoritative again the moment the ramp completes or is cancelled (every
 * set_user_volume() caller already restores it explicitly). */
#define VOLUME_RAMP_DURATION_US (50 * 1000)
static gdouble volume_ramp_start = 0.8;
static gdouble volume_ramp_target = 0.8;
static gint64 volume_ramp_started_at = 0;
/* The ramp is timed in audio frames actually processed, not wall-clock time.
 * GStreamer pushes buffers in bursts, ahead of playback; timing each buffer by
 * when the probe happened to run gave consecutive buffers overlapping or
 * skipped slices of the ramp, so the applied gain stepped backwards/forwards
 * at every ~26 ms buffer boundary -- audible clicks, worst when coming up from
 * silence, and a volume that seemed to fight the slider. Counting frames makes
 * each buffer start at exactly the gain the previous one ended on.
 * volume_ramp_lock guards start/target/elapsed/user_volume between the main
 * thread (begin_user_volume_ramp) and the streaming thread (the probe). */
static guint64 volume_ramp_elapsed_frames = 0;
static GMutex volume_ramp_lock;
/* Transport fade: a short gain envelope applied on top of the user volume
 * when the track changes during playback. LOAD used to switch the pipeline to
 * READY while audio was playing, cutting the waveform mid-cycle -- an audible
 * pop on every double-click of a new track. Now: fade out, wait until the
 * silent point is actually being heard, then switch, then fade the new track
 * in. Frame-timed in the same probe as the volume ramp; guarded by
 * volume_ramp_lock. transport_fade_gain is the gain of the last processed
 * frame. */
#define TRANSPORT_FADE_OUT_US (25 * 1000)
#define TRANSPORT_FADE_IN_US (20 * 1000)
#define TRANSPORT_FADE_MAX_WAIT_US (400 * 1000)
static gdouble transport_fade_gain = 1.0;
static gdouble transport_fade_from = 1.0;
static gdouble transport_fade_target = 1.0;
static gint64 transport_fade_duration_us = 0;
static guint64 transport_fade_elapsed_frames = 0;
static gboolean transport_fade_active = FALSE;
static gboolean transport_fade_silent = FALSE;          /* fade-out reached 0 */
static GstClockTime transport_fade_silent_pts = GST_CLOCK_TIME_NONE; /* stream time where silence begins */
static gboolean volume_ramp_active = FALSE;
/* Set when a ramp finishes, so the element's "volume" property gets
 * restored on the START of the NEXT buffer probe call instead of
 * immediately -- see the comment in volume_ramp_probe_cb where this is set
 * for why restoring it on the SAME buffer double-applies gain. */
static gboolean volume_ramp_pending_restore = FALSE;
/* Set when a ramp STARTS, so the element's "volume" property gets forced to
 * 1.0 (pass-through) from INSIDE the pad probe -- i.e. on the streaming
 * thread, immediately before the same buffer's chain() call -- instead of
 * from begin_user_volume_ramp() on the main thread. begin_user_volume_ramp()
 * runs via g_main_context_invoke() on the default GMainContext (the main
 * thread running g_main_loop_run()), which is a DIFFERENT thread than the
 * one calling this pad probe. Forcing the property directly from there had
 * no ordering guarantee relative to the streaming thread: a buffer could
 * have its probe read volume_ramp_active as still-stale FALSE (so it passed
 * through untouched) while chain() for that same buffer, running
 * concurrently, ended up reading the property AFTER it was already forced
 * to 1.0 -- a brief, real jump to unscaled full volume for one buffer,
 * heard as a small pop right as a ramp begins. Deferring the force into the
 * probe (checked only once volume_ramp_active has already been observed
 * TRUE for that buffer, see below) guarantees the property write and that
 * buffer's decision to apply direct sample scaling always land on the same
 * buffer, on the same thread. */
static gboolean volume_ramp_pending_start = FALSE;
static GstAudioInfo ramp_audio_info;
static gboolean ramp_audio_info_valid = FALSE;
static GstCaps *ramp_cached_caps = NULL;

static void event_line(const char *name, const char *arg);
static void trace_line(const char *kind, const char *detail);

/* Applies a volume value immediately, with no ramp -- used by every caller
 * except the ordinary slider path (see begin_user_volume_ramp below). The
 * element stays in the audio-sink bin, immediately upstream of the real
 * sink. This placement is important: putting the user-volume element back in
 * playbin's audio-filter chain reintroduces the ~1 second queue latency that
 * the user reported. ReplayGain remains a separate upstream element. */
/* Never hand the volume element exactly 0.0. At 0.0 GstVolume switches to
 * emitting GAP-flagged silence, and while in that mode about 1.4 s of audio
 * piled up downstream (measured on a null sink): dragging the slider back up
 * from 0 left the level frozen near the first step for ~1.4 s, then it jumped
 * straight to the target -- the "fighting" slider and the pop. -120 dB is
 * still true silence for 16/24-bit output (samples round to 0) but keeps the
 * element on its normal processing path. */
#define USER_VOLUME_ELEMENT_FLOOR 1e-6
static void set_user_volume(gdouble value) {
  value = CLAMP(value, 0.0, 1.0);
  user_volume = value;
  if (!user_volume_element) return;
  g_object_set(G_OBJECT(user_volume_element), "volume", MAX(value, USER_VOLUME_ELEMENT_FLOOR), NULL);
}

static void cancel_user_volume_ramp(void) {
  volume_ramp_active = FALSE;
  volume_ramp_pending_restore = FALSE;
  volume_ramp_pending_start = FALSE;
}

/* Refreshes the cached GstAudioInfo for the pad's currently negotiated caps.
 * Cheap to call on every buffer while a ramp is active: caps rarely change
 * mid-stream, and gst_caps_is_equal() short-circuits the real work when they
 * haven't. Only interleaved layouts are accepted -- that is what "volume"
 * (and this whole pipeline) has always negotiated in practice, and treating
 * an unexpected planar layout as "unknown" (falling back to the safe
 * per-buffer property step below) is far better than silently scaling the
 * wrong bytes. */
static gboolean ensure_ramp_audio_info(GstPad *pad) {
  GstCaps *caps = gst_pad_get_current_caps(pad);
  if (!caps) return ramp_audio_info_valid;
  if (ramp_cached_caps && gst_caps_is_equal(ramp_cached_caps, caps)) {
    gst_caps_unref(caps);
    return ramp_audio_info_valid;
  }
  GstAudioInfo info;
  gboolean ok = gst_audio_info_from_caps(&info, caps) &&
                GST_AUDIO_INFO_LAYOUT(&info) == GST_AUDIO_LAYOUT_INTERLEAVED;
  if (ok) ramp_audio_info = info;
  if (ramp_cached_caps) gst_caps_unref(ramp_cached_caps);
  ramp_cached_caps = caps; /* takes ownership */
  ramp_audio_info_valid = ok;
  return ok;
}

/* Multiplies every sample in `buffer` in place by a gain that linearly
 * interpolates from start_gain (its first frame) to end_gain (its last
 * frame) -- a real sample-accurate ramp within the buffer, not one flat
 * value for the whole thing. Limited to the sample formats GStreamer's own
 * "volume" element supports (S16/S32/F32/F64 interleaved), since that is
 * guaranteed to be what negotiates here; returns FALSE (leaving the buffer
 * untouched) for anything else so the caller can fall back safely instead of
 * risking scaling the wrong bytes. */
static gboolean apply_sample_ramp(GstBuffer *buffer, const GstAudioInfo *info, gdouble start_gain, gdouble end_gain) {
  const gint channels = GST_AUDIO_INFO_CHANNELS(info);
  const gint bpf = GST_AUDIO_INFO_BPF(info);
  const GstAudioFormat fmt = GST_AUDIO_INFO_FORMAT(info);
  if (channels <= 0 || bpf <= 0) return FALSE;
  switch (fmt) {
    case GST_AUDIO_FORMAT_S16:
    case GST_AUDIO_FORMAT_S32:
    case GST_AUDIO_FORMAT_F32:
    case GST_AUDIO_FORMAT_F64:
      break;
    default:
      return FALSE;
  }
  GstMapInfo map;
  if (!gst_buffer_map(buffer, &map, GST_MAP_READWRITE)) return FALSE;
  const guint total_frames = (guint)(map.size / (gsize)bpf);
  if (total_frames == 0) { gst_buffer_unmap(buffer, &map); return TRUE; }
  guint8 *base = map.data;
  for (guint frame = 0; frame < total_frames; frame++) {
    const gdouble t = total_frames > 1 ? (gdouble)frame / (gdouble)(total_frames - 1) : 1.0;
    const gdouble gain = start_gain + (end_gain - start_gain) * t;
    guint8 *frame_ptr = base + (gsize)frame * (gsize)bpf;
    for (gint ch = 0; ch < channels; ch++) {
      switch (fmt) {
        case GST_AUDIO_FORMAT_S16: {
          gint16 *s = (gint16 *)(frame_ptr + (gsize)ch * sizeof(gint16));
          gdouble v = (*s) * gain;
          v = CLAMP(v, -32768.0, 32767.0);
          *s = (gint16)v;
          break;
        }
        case GST_AUDIO_FORMAT_S32: {
          gint32 *s = (gint32 *)(frame_ptr + (gsize)ch * sizeof(gint32));
          gdouble v = (*s) * gain;
          v = CLAMP(v, -2147483648.0, 2147483647.0);
          *s = (gint32)v;
          break;
        }
        case GST_AUDIO_FORMAT_F32: {
          gfloat *s = (gfloat *)(frame_ptr + (gsize)ch * sizeof(gfloat));
          *s = (gfloat)((*s) * gain);
          break;
        }
        case GST_AUDIO_FORMAT_F64: {
          gdouble *s = (gdouble *)(frame_ptr + (gsize)ch * sizeof(gdouble));
          *s = (*s) * gain;
          break;
        }
        default:
          break;
      }
    }
  }
  gst_buffer_unmap(buffer, &map);
  return TRUE;
}

/* Runs on the streaming thread, once per buffer that actually reaches the
 * user-volume element's sink pad. While a ramp is active, the element's own
 * "volume" property stays forced at 1.0 (see begin_user_volume_ramp) and
 * this function does ALL the gain application itself, directly on the raw
 * samples -- see apply_sample_ramp and the architecture comment above
 * VOLUME_RAMP_DURATION_US for why. */
static GstPadProbeReturn volume_ramp_probe_cb(GstPad *pad, GstPadProbeInfo *info, gpointer unused) {
  (void)unused;
  /* Runs unconditionally, before the "is a ramp active" check below: this is
   * what makes the restore land on a genuinely different, not-yet-processed
   * buffer than the one whose samples the finishing ramp just scaled. */
  if (volume_ramp_pending_restore) {
    volume_ramp_pending_restore = FALSE;
    set_user_volume(volume_ramp_target);
  }
  g_mutex_lock(&volume_ramp_lock);
  const gboolean fade_on = transport_fade_active || transport_fade_gain < 1.0;
  g_mutex_unlock(&volume_ramp_lock);
  if (!volume_ramp_active && !fade_on) return GST_PAD_PROBE_OK;
  GstBuffer *buffer = GST_PAD_PROBE_INFO_BUFFER(info);
  if (!buffer) return GST_PAD_PROBE_OK;

  const gint64 now = g_get_monotonic_time();
  const gint64 buf_start_us = now - volume_ramp_started_at;

  if (!ensure_ramp_audio_info(pad)) {
    /* Format not yet known/supported -- fall back to the old buffer-level
     * property step for the user ramp (the fade can't scale samples it
     * can't read, so it completes immediately rather than stalling a LOAD). */
    if (volume_ramp_active) {
      volume_ramp_pending_start = FALSE;
      if (buf_start_us >= VOLUME_RAMP_DURATION_US) { set_user_volume(volume_ramp_target); volume_ramp_active = FALSE; }
      else { const gdouble fraction = (gdouble)buf_start_us / (gdouble)VOLUME_RAMP_DURATION_US; set_user_volume(volume_ramp_start + (volume_ramp_target - volume_ramp_start) * fraction); }
    }
    g_mutex_lock(&volume_ramp_lock);
    if (transport_fade_active) {
      transport_fade_active = FALSE;
      transport_fade_gain = transport_fade_target;
      if (transport_fade_target <= 0.0) { transport_fade_silent = TRUE; transport_fade_silent_pts = GST_BUFFER_PTS(buffer); }
    }
    g_mutex_unlock(&volume_ramp_lock);
    return GST_PAD_PROBE_OK;
  }

  /* Force pass-through HERE, on the streaming thread, for the exact same
   * buffer apply_sample_ramp is about to scale below -- not eagerly from
   * begin_user_volume_ramp() on the main thread (see volume_ramp_pending_start's
   * declaration comment for the cross-thread race this closes). */
  if (volume_ramp_active && volume_ramp_pending_start) {
    volume_ramp_pending_start = FALSE;
    if (user_volume_element) g_object_set(G_OBJECT(user_volume_element), "volume", 1.0, NULL);
  }

  const gint bpf = GST_AUDIO_INFO_BPF(&ramp_audio_info);
  const gint rate = GST_AUDIO_INFO_RATE(&ramp_audio_info);
  const gsize buf_size = gst_buffer_get_size(buffer);
  const guint total_frames = (bpf > 0) ? (guint)(buf_size / (gsize)bpf) : 0;

  gboolean finishing = FALSE;
  gboolean ramping = volume_ramp_active;
  /* User-volume gains for this buffer. Without an active ramp the element's
   * own "volume" property applies the user volume after this probe, so the
   * samples here only need the transport fade (user factor 1.0). */
  gdouble start_gain = 1.0, end_gain = 1.0;
  gdouble fade_start = 1.0, fade_end = 1.0;
  g_mutex_lock(&volume_ramp_lock);
  if (ramping) {
    const guint64 ramp_frames = rate > 0 ? MAX((guint64)1, (guint64)rate * VOLUME_RAMP_DURATION_US / 1000000) : 1;
    const guint64 done = volume_ramp_elapsed_frames;
    const guint64 after = done + total_frames;
    volume_ramp_elapsed_frames = after;
    if (done >= ramp_frames) {
      start_gain = end_gain = volume_ramp_target;
      finishing = TRUE;
    } else {
      start_gain = volume_ramp_start + (volume_ramp_target - volume_ramp_start) * ((gdouble)done / (gdouble)ramp_frames);
      if (after >= ramp_frames) {
        /* Reaching the target partway through this buffer: the linear
         * in-buffer interpolation below spreads the remainder across the whole
         * buffer, which is at most one buffer (~26 ms) slower -- never a jump. */
        end_gain = volume_ramp_target;
        finishing = TRUE;
      } else {
        end_gain = volume_ramp_start + (volume_ramp_target - volume_ramp_start) * ((gdouble)after / (gdouble)ramp_frames);
      }
    }
    /* Publish the gain the last frame of this buffer will carry before
     * releasing the lock, so a retarget arriving now starts from it. */
    user_volume = end_gain;
  }
  if (transport_fade_active) {
    const guint64 fade_frames = rate > 0 ? MAX((guint64)1, (guint64)rate * (guint64)transport_fade_duration_us / 1000000) : 1;
    const guint64 done = transport_fade_elapsed_frames;
    const guint64 after = done + total_frames;
    transport_fade_elapsed_frames = after;
    const gdouble span = transport_fade_target - transport_fade_from;
    fade_start = done >= fade_frames ? transport_fade_target : transport_fade_from + span * ((gdouble)done / (gdouble)fade_frames);
    fade_end = after >= fade_frames ? transport_fade_target : transport_fade_from + span * ((gdouble)after / (gdouble)fade_frames);
    transport_fade_gain = fade_end;
    if (after >= fade_frames) {
      transport_fade_active = FALSE;
      if (transport_fade_target <= 0.0) {
        transport_fade_silent = TRUE;
        /* Silence starts after this buffer; handle_pending_load waits until
         * the pipeline's playback position passes this point. */
        const GstClockTime pts = GST_BUFFER_PTS(buffer);
        const GstClockTime dur = GST_BUFFER_DURATION(buffer);
        transport_fade_silent_pts = GST_CLOCK_TIME_IS_VALID(pts) ? pts + (GST_CLOCK_TIME_IS_VALID(dur) ? dur : 0) : GST_CLOCK_TIME_NONE;
      }
    }
  } else {
    fade_start = fade_end = transport_fade_gain;
  }
  g_mutex_unlock(&volume_ramp_lock);

  if (!ramping && fade_start >= 1.0 && fade_end >= 1.0) return GST_PAD_PROBE_OK;

  buffer = gst_buffer_make_writable(buffer);
  GST_PAD_PROBE_INFO_DATA(info) = buffer; /* make_writable may return a new buffer instance */
  if (apply_sample_ramp(buffer, &ramp_audio_info, start_gain * fade_start, end_gain * fade_end)) {
    if (ramping) user_volume = end_gain; /* keep the C-side value in sync for continuity/introspection */
  } else if (ramping) {
    /* Mapping failed (e.g. a non-writable/foreign-memory buffer) -- fall
     * back to the property step for just this buffer rather than leaving
     * the element at its forced 1.0 pass-through with nothing correcting it. */
    set_user_volume(end_gain);
  }

  if (finishing) {
    volume_ramp_active = FALSE;
    /* Restoring the element's property here would double-apply gain to this
     * already-scaled buffer (the probe runs before the element's chain); the
     * restore is deferred to the next buffer -- see volume_ramp_pending_restore. */
    volume_ramp_pending_restore = TRUE;
  }
  return GST_PAD_PROBE_OK;
}

/* Starts (or smoothly retargets) a 50 ms ramp from the current actual volume
 * to the new target -- short enough to still track a continuous slider drag
 * in near-real-time (a 120ms ramp made the audible volume visibly lag behind
 * the mouse while held: every new position restarted the ramp's countdown,
 * so it never had time to catch up until the drag stopped), while still long
 * enough to avoid the hard click of an instant jump. Retargeting mid-ramp
 * instead of restarting from scratch is what keeps a fast slider drag smooth
 * rather than stair-stepping: each new command just moves the endpoint, the
 * ramp that is already in flight keeps running from wherever it currently
 * is.
 *
 * A rate-limited variant of this (skipping the start_time/anchor reset for
 * retargets closer together than ~12ms, to reduce slope changes during a
 * fast drag) was tried and reverted: confirmed live, it made popping
 * *worse*, not better. During a SUSTAINED fast drag (commands arriving
 * faster than the rate limit, continuously), the anchor never gets
 * refreshed at all -- it just ages while the target keeps moving, so once
 * more than 50ms has passed since that now-stale anchor, every buffer
 * starts seeing "elapsed >= VOLUME_RAMP_DURATION_US" and snaps instantly to
 * whatever the target happens to be at that moment -- a real, audible
 * instant jump, repeated for as long as the fast drag continues. Always
 * refreshing the anchor on every retarget (this version) means the ramp
 * never goes stale relative to a moving target, even under continuous rapid
 * retargeting.
 *
 * The element's own "volume" property is forced to 1.0 for the duration of
 * the ramp -- volume_ramp_probe_cb applies the real gain directly to
 * samples instead, so the element must not ALSO apply gain on top of that
 * (which would double-apply it). The property becomes authoritative again
 * the moment the ramp ends (see volume_ramp_probe_cb).
 *
 * A variant of this that skipped the ramp entirely and delegated to the
 * real sink's own native "volume" property (pulsesink) was tried and
 * reverted: confirmed live, it meant a single big jump (e.g. 100% down to
 * 14%) became a real, completely unramped instant change, because the
 * assumption that PulseAudio/PipeWire's own mixing stage would smooth it
 * the way it does for the OS's own volume control did not hold for at
 * least this PipeWire setup. This in-pipeline sample-level ramp is the sole
 * mechanism again -- it doesn't depend on any assumption about how the
 * sink/audio server handles a property write. */
static void begin_user_volume_ramp(gdouble target) {
  target = CLAMP(target, 0.0, 1.0);
  g_mutex_lock(&volume_ramp_lock);
  /* user_volume is the gain the probe applied to the last frame it scaled, so
   * a retarget mid-ramp continues from exactly where the audio currently is. */
  volume_ramp_start = user_volume;
  volume_ramp_target = target;
  volume_ramp_started_at = g_get_monotonic_time();
  volume_ramp_elapsed_frames = 0;
  volume_ramp_active = TRUE;
  g_mutex_unlock(&volume_ramp_lock);
  /* A retarget arriving between a ramp finishing and its deferred property
   * restore landing (see volume_ramp_pending_restore) must not let that
   * stale restore fire later and clobber THIS new ramp's forced 1.0. */
  volume_ramp_pending_restore = FALSE;
  /* Force pass-through is applied from INSIDE volume_ramp_probe_cb, on the
   * streaming thread, not here -- this function runs on the main thread (via
   * command_tick's g_main_context_invoke), a different thread than the one
   * calling the pad probe/chain() for the pipeline. See
   * volume_ramp_pending_start's declaration comment for the race that
   * setting the property directly from here used to cause. */
  volume_ramp_pending_start = TRUE;
}

static void apply_track_gain(gdouble value) {
  if (!track_gain_element) return;
  if (bit_perfect) value = 1.0; /* ReplayGain would alter the samples */
  g_object_set(track_gain_element, "volume", CLAMP(value, 0.0, 8.0), NULL);
}

static void apply_output_mute(gboolean muted) {
  if (!player) return;
  g_object_set(player, "mute", muted, NULL);
}

static void trace_line(const char *kind, const char *detail) {
  if (!trace_enabled || !event_fp) return;
  if (detail) fprintf(event_fp, "TRACE\t%" G_GINT64_FORMAT "\t%s\t%s\n", g_get_monotonic_time(), kind, detail);
  else fprintf(event_fp, "TRACE\t%" G_GINT64_FORMAT "\t%s\n", g_get_monotonic_time(), kind);
  fflush(event_fp);
}

static void emit_spectrum_message(GstMessage *msg) {
  const GstStructure *st = gst_message_get_structure(msg);
  if (!st || !gst_structure_has_name(st, "spectrum")) return;
  const GValue *mag = gst_structure_get_value(st, "magnitude");
  if (!mag || !GST_VALUE_HOLDS_LIST(mag)) return;
  const guint n = gst_value_list_get_size(mag);
  if (!n) return;
  /* Keep IPC deliberately tiny: 64 logarithmic FFT bands, normalized from
   * GStreamer's dB magnitude range. This is actual audio analysis from the
   * native playback pipeline, not an animation synthesized from time. */
  GString *out = g_string_sized_new(n * 5);
  const guint limit = MIN(n, 64u);
  for (guint i = 0; i < limit; ++i) {
    const GValue *v = gst_value_list_get_value(mag, i);
    const gdouble db = G_VALUE_HOLDS_DOUBLE(v) ? g_value_get_double(v) :
      (G_VALUE_HOLDS_FLOAT(v) ? g_value_get_float(v) : -80.0);
    const gdouble level = CLAMP((db + 80.0) / 80.0, 0.0, 1.0);
    if (i) g_string_append_c(out, ',');
    g_string_append_printf(out, "%.3f", level);
  }
  event_line("SPECTRUM", out->str);
  g_string_free(out, TRUE);
}

static void event_line(const char *name, const char *arg) {
  if (!event_fp) return;
  if (arg) fprintf(event_fp, "%s\t%s\n", name, arg);
  else fprintf(event_fp, "%s\n", name);
  fflush(event_fp);
}

static gchar *path_to_uri(const gchar *path) {
  return g_filename_to_uri(path, NULL, NULL);
}

static void set_next_path(const gchar *path) {
  gchar *uri = path_to_uri(path);
  if (!uri) { event_line("ERROR", "cannot make next file URI"); return; }
  g_mutex_lock(&next_lock);
  g_free(next_uri);
  next_uri = uri;
  g_mutex_unlock(&next_lock);
}

static void about_to_finish_cb(GstElement *pb, gpointer unused) {
  gchar *uri = NULL;
  g_mutex_lock(&next_lock);
  if (next_uri) uri = g_strdup(next_uri);
  g_mutex_unlock(&next_lock);
  if (!uri) return;
  /* playbin keeps its pipeline/clock and starts the new URI at the boundary. */
  g_object_set(pb, "uri", uri, NULL);
  event_line("ABOUT_TO_FINISH", NULL);
  g_free(uri);
}

/* A LOAD's start seek that could not run yet because the pipeline was still
 * prerolling (the bounded 250 ms wait expired -- a cold disk, a slow machine,
 * the first load after launch). Applied on ASYNC_DONE instead. -1 = none. */
static gint64 pending_start_seek = -1;

static gboolean bus_cb(GstBus *bus, GstMessage *msg, gpointer unused) {
  switch (GST_MESSAGE_TYPE(msg)) {
    case GST_MESSAGE_ASYNC_DONE:
      if (pending_start_seek >= 0 && GST_MESSAGE_SRC(msg) == GST_OBJECT(player)) {
        gint64 pos = pending_start_seek;
        pending_start_seek = -1;
        if (!gst_element_seek(player, 1.0, GST_FORMAT_TIME,
            GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_ACCURATE,
            GST_SEEK_TYPE_SET, pos, GST_SEEK_TYPE_NONE, GST_CLOCK_TIME_NONE))
          trace_line("SEEK", "deferred start seek failed");
      }
      break;
    case GST_MESSAGE_EOS:
      event_line("EOS", NULL);
      break;
    case GST_MESSAGE_ERROR: {
      GError *err = NULL; gchar *dbg = NULL;
      gst_message_parse_error(msg, &err, &dbg);
      /* HARD AUDIO SAFETY: an unknown decoder/sink/pipeline error must never
       * continue emitting whatever state the audio path happens to be in.
       * Silence first, then stop the pipeline, then report the fatal fault.
       * The renderer deliberately does not auto-retry this condition; recovery
       * requires an explicit fresh playback/backend startup. */
      apply_output_mute(TRUE);
      gst_element_set_state(player, GST_STATE_READY);
      trace_line("ERROR", err ? err->message : "unknown GStreamer error");
      if (dbg) trace_line("ERROR_DEBUG", dbg);
      event_line("ERROR", err ? err->message : "unknown GStreamer error");
      event_line("FATAL_ERROR", err ? err->message : "unknown GStreamer error");
      if (dbg) g_free(dbg);
      if (err) g_error_free(err);
      break;
    }
    case GST_MESSAGE_ELEMENT:
      if (spectrum && GST_MESSAGE_SRC(msg) == GST_OBJECT(spectrum)) emit_spectrum_message(msg);
      break;
    case GST_MESSAGE_BUFFERING: {
      gint percent = 0;
      gst_message_parse_buffering(msg, &percent);
      char b[32]; snprintf(b, sizeof(b), "%d", percent);
      event_line("BUFFERING", b);
      break;
    }
    case GST_MESSAGE_STREAM_START:
      stream_started = TRUE;
      trace_line("STREAM_START", "stream_started=1");
      event_line("STREAM_START", NULL);
      break;
    case GST_MESSAGE_STATE_CHANGED:
      if (GST_MESSAGE_SRC(msg) == GST_OBJECT(player)) {
        GstState old_s, new_s, pending;
        gst_message_parse_state_changed(msg, &old_s, &new_s, &pending);
        if (trace_enabled) { char detail[256]; snprintf(detail, sizeof(detail), "old=%s new=%s pending=%s stream_started=%d playing=%d user_muted=%d", gst_element_state_get_name(old_s), gst_element_state_get_name(new_s), gst_element_state_get_name(pending), stream_started, playing_state, user_muted); trace_line("STATE", detail); }
        if (new_s == GST_STATE_PLAYING) {
          playing_state = TRUE;
          /* Never unmute merely because PLAY was requested. The native pipeline
           * must first report both a stream and PLAYING state. This closes the
           * dangerous window where a broken decoder could feed the sink before
           * GStreamer has reported its error. */
          if (stream_started && !user_muted) {
            apply_output_mute(FALSE);
            apply_track_gain(track_gain);
            set_user_volume(user_volume);
          }
          event_line("PLAYING", NULL);
        } else if (new_s == GST_STATE_PAUSED) {
          playing_state = FALSE;
          event_line("PAUSED", NULL);
        }
      }
      break;
    default: break;
  }
  return G_SOURCE_CONTINUE;
}

static void handle_load(const gchar *b64, gdouble offset, gdouble start, gdouble end) {
  gsize len = 0;
  guchar *decoded = g_base64_decode(b64, &len);
  if (!decoded || len == 0) { g_free(decoded); event_line("ERROR", "invalid path"); return; }
  gchar *path = g_strndup((const gchar*)decoded, len);
  g_free(decoded);
  gchar *uri = path_to_uri(path);
  if (!uri) { g_free(path); event_line("ERROR", "cannot make file URI"); return; }

  trim_start = MAX(0.0, start);
  trim_end = MAX(0.0, end);
  trim_end_emitted = FALSE;
  stream_started = FALSE;
  playing_state = FALSE;
  g_mutex_lock(&next_lock);
  g_clear_pointer(&next_uri, g_free);
  g_mutex_unlock(&next_lock);

  pending_start_seek = -1;
  gst_element_set_state(player, GST_STATE_READY);
  g_object_set(player, "uri", uri, NULL);
  GstStateChangeReturn r = gst_element_set_state(player, GST_STATE_PAUSED);
  if (r == GST_STATE_CHANGE_FAILURE) {
    event_line("ERROR", "failed to preroll GStreamer pipeline");
    g_free(uri); g_free(path); return;
  }
  /* Bound preroll so a slow decoder/demuxer cannot hold the command loop for seconds.
   * PLAY follows immediately; GStreamer continues completing its state transition
   * asynchronously if the bounded wait expires. */
  gst_element_get_state(player, NULL, NULL, 250 * GST_MSECOND);

  /* LOAD carries offset, trim_start, and trim_end. For a trimmed track the
   * renderer's offset is relative to trim_start. */
  /* Always explicitly seek the fresh URI, including offset 0. A persistent
   * playbin can retain a previous transport position across a READY/URI
   * replacement on some decoder/state-transition paths; an explicit zero seek
   * makes a fresh user selection unambiguous. */
  {
    gdouble absolute = trim_start + MAX(0.0, offset);
    if (trim_end > trim_start) absolute = MIN(absolute, trim_end);
    gint64 pos = (gint64)(absolute * GST_SECOND);
    if (!gst_element_seek(player, 1.0, GST_FORMAT_TIME,
        GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_ACCURATE,
        GST_SEEK_TYPE_SET, pos, GST_SEEK_TYPE_NONE, GST_CLOCK_TIME_NONE)) {
      /* Not an error: the pipeline is still prerolling. Any ERROR event puts
       * the renderer's backend into its fatal state, so a slow first load
       * used to fail the song outright. Seek once preroll completes. */
      pending_start_seek = pos;
      trace_line("SEEK", "start seek deferred until preroll completes");
    }
  }
  event_line("LOADED", path);
  g_free(uri);
  g_free(path);
}

static void handle_seek(gdouble offset) {
  gdouble relative = MAX(0.0, offset);
  gdouble absolute = trim_start + relative;
  if (trim_end > trim_start) absolute = MIN(absolute, trim_end);
  trim_end_emitted = FALSE;
  gint64 pos = (gint64)(absolute * GST_SECOND);
  if (!gst_element_seek(player, 1.0, GST_FORMAT_TIME,
      GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_ACCURATE,
      GST_SEEK_TYPE_SET, pos, GST_SEEK_TYPE_NONE, GST_CLOCK_TIME_NONE))
    event_line("ERROR", "seek failed");
  else
    event_line("SEEKED", NULL);
}

static gboolean position_tick(gpointer unused) {
  if (!player || shutting_down) return G_SOURCE_CONTINUE;
  gint64 pos = GST_CLOCK_TIME_NONE;
  if (gst_element_query_position(player, GST_FORMAT_TIME, &pos) && GST_CLOCK_TIME_IS_VALID(pos)) {
    const gdouble absolute = (double)pos / (double)GST_SECOND;
    if (trim_end > trim_start && !trim_end_emitted && absolute >= trim_end) {
      trim_end_emitted = TRUE;
      event_line("TRIM_END", NULL);
      /* TRIM_END is intentionally emitted before PAUSED. The renderer can queue
       * the next LOAD immediately; the later PAUSED state event is then ignored
       * because the old gstActive session has already ended. */
      gst_element_set_state(player, GST_STATE_PAUSED);
      return G_SOURCE_CONTINUE;
    }
    const gdouble relative = MAX(0.0, absolute - trim_start);
    char b[64]; snprintf(b, sizeof(b), "%.6f", relative);
    event_line("POSITION", b);
  }
  return G_SOURCE_CONTINUE;
}

/* ---- Deferred LOAD (see the transport fade state near the top) ---- */
static gboolean load_pending = FALSE;
static gchar *pending_load_b64 = NULL;
static gdouble pending_load_offset = 0.0, pending_load_start = 0.0, pending_load_end = 0.0;
static gint64 pending_load_since = 0;
static gboolean command_tick(gpointer unused);

static void begin_transport_fade(gdouble target, gint64 duration_us, gboolean from_silence) {
  g_mutex_lock(&volume_ramp_lock);
  if (from_silence) transport_fade_gain = 0.0;
  transport_fade_from = transport_fade_gain;
  transport_fade_target = target;
  transport_fade_duration_us = duration_us;
  transport_fade_elapsed_frames = 0;
  transport_fade_active = TRUE;
  transport_fade_silent = FALSE;
  transport_fade_silent_pts = GST_CLOCK_TIME_NONE;
  g_mutex_unlock(&volume_ramp_lock);
}

static void run_pending_load(void) {
  gchar *b64 = pending_load_b64;
  pending_load_b64 = NULL;
  load_pending = FALSE;
  if (b64) handle_load(b64, pending_load_offset, pending_load_start, pending_load_end);
  g_free(b64);
  /* The new track starts from silence and fades in, so starting mid-song
   * (a remembered position) doesn't click either. */
  begin_transport_fade(1.0, TRANSPORT_FADE_IN_US, TRUE);
  /* Commands that arrived after the LOAD (normally its PLAY) were held back
   * so they apply to the new track, in order. */
  command_tick(NULL);
}

/* Polls until the faded-out point is actually being heard -- the sink and
 * audio server hold already-processed audio, so flushing right after the fade
 * would still cut unfaded audio. Capped so a LOAD can never hang. */
static gboolean pending_load_tick(gpointer unused) {
  (void)unused;
  if (!load_pending) return G_SOURCE_REMOVE;
  g_mutex_lock(&volume_ramp_lock);
  const gboolean silent = transport_fade_silent;
  const GstClockTime silent_pts = transport_fade_silent_pts;
  g_mutex_unlock(&volume_ramp_lock);
  gboolean ready = g_get_monotonic_time() - pending_load_since >= TRANSPORT_FADE_MAX_WAIT_US;
  if (!ready && silent) {
    gint64 position = 0;
    ready = !GST_CLOCK_TIME_IS_VALID(silent_pts)
      || (gst_element_query_position(player, GST_FORMAT_TIME, &position) && position >= (gint64)silent_pts);
  }
  if (!ready) return G_SOURCE_CONTINUE;
  if (trace_enabled) { char detail[96]; snprintf(detail, sizeof(detail), "waited_ms=%.1f silent=%d", (g_get_monotonic_time() - pending_load_since) / 1000.0, silent); trace_line("LOAD_AFTER_FADE", detail); }
  run_pending_load();
  return G_SOURCE_REMOVE;
}

static gboolean command_tick(gpointer unused) {
  /* This callback is scheduled by the stdin reader whenever a command arrives.
   * It is deliberately event-driven rather than polled every 5 ms: slider
   * volume changes should reach GStreamer as soon as the command crosses the
   * process boundary, without adding a periodic control latency or building a
   * backlog of stale slider positions. */
  g_atomic_int_set(&command_dispatch_pending, 0);
  /* While a LOAD is fading out, hold every later command in the queue;
   * run_pending_load() drains them afterwards, in order. */
  if (load_pending) return G_SOURCE_REMOVE;
  gboolean stop_draining = FALSE;
  gboolean pending_volume = FALSE;
  gdouble latest_volume = user_volume;
  gchar *line;
  while ((line = g_async_queue_try_pop(commands)) != NULL) {
    gchar **parts = g_strsplit(line, "\t", 0);
    /* Optional LOAD fields are read by index below; bound them by the real
     * field count so a short command can't read past the NULL terminator. */
    const guint nparts = g_strv_length(parts);
    const gchar *arg2 = nparts > 2 ? parts[2] : NULL, *arg3 = nparts > 3 ? parts[3] : NULL, *arg4 = nparts > 4 ? parts[4] : NULL;
    if (parts[0]) {
      if (trace_enabled) {
        if (!g_strcmp0(parts[0], "LOAD") && parts[1]) {
          gsize n=0; guchar *d=g_base64_decode(parts[1], &n); gchar *path=(d&&n)?g_strndup((const gchar*)d,n):g_strdup("<invalid>"); gchar *uri=path_to_uri(path); gchar *detail=g_strdup_printf("LOAD path=%s offset=%s start=%s end=%s", uri?uri:path, arg2?arg2:"0", arg3?arg3:"0", arg4?arg4:"0"); trace_line("COMMAND",detail); g_free(detail); g_free(uri); g_free(path); g_free(d);
        } else if (!g_strcmp0(parts[0], "NEXT") && parts[1]) trace_line("COMMAND", "NEXT");
        else if (parts[1]) { gchar *detail=g_strdup_printf("%s arg=%s",parts[0],parts[1]); trace_line("COMMAND",detail); g_free(detail); }
        else trace_line("COMMAND",parts[0]);
      }
      if (!g_strcmp0(parts[0], "LOAD") && parts[1]) {
        const gdouble load_offset = arg2 ? g_ascii_strtod(arg2, NULL) : 0.0;
        const gdouble load_start = arg3 ? g_ascii_strtod(arg3, NULL) : 0.0;
        const gdouble load_end = arg4 ? g_ascii_strtod(arg4, NULL) : 0.0;
        if (playing_state && stream_started && user_volume_element && !bit_perfect) {
          /* Audio is playing: fade out first instead of cutting it (the pop). */
          g_free(pending_load_b64);
          pending_load_b64 = g_strdup(parts[1]);
          pending_load_offset = load_offset; pending_load_start = load_start; pending_load_end = load_end;
          pending_load_since = g_get_monotonic_time();
          load_pending = TRUE;
          begin_transport_fade(0.0, TRANSPORT_FADE_OUT_US, FALSE);
          g_timeout_add(4, pending_load_tick, NULL);
          stop_draining = TRUE;
        } else {
          handle_load(parts[1], load_offset, load_start, load_end);
        }
      } else if (!g_strcmp0(parts[0], "NEXT") && parts[1]) {
        gsize len = 0; guchar *d = g_base64_decode(parts[1], &len);
        if (d && len) { gchar *path = g_strndup((const gchar*)d, len); set_next_path(path); g_free(path); }
        g_free(d);
      } else if (!g_strcmp0(parts[0], "PLAY")) {
        gst_element_set_state(player, GST_STATE_PLAYING);
      } else if (!g_strcmp0(parts[0], "PAUSE")) {
        gst_element_set_state(player, GST_STATE_PAUSED);
      } else if (!g_strcmp0(parts[0], "SEEKPLAY") && parts[1]) {
        handle_seek(g_ascii_strtod(parts[1], NULL));
        /* A FLUSH seek may transiently preroll PAUSED. Explicitly restore the
         * native PLAYING state after the seek so releasing a playing scrubber
         * can never leave transport paused. */
        gst_element_set_state(player, GST_STATE_PLAYING);
      } else if (!g_strcmp0(parts[0], "STOP")) {
        stream_started = FALSE;
        playing_state = FALSE;
        apply_output_mute(TRUE);
        gst_element_set_state(player, GST_STATE_READY);
      } else if (!g_strcmp0(parts[0], "SEEK") && parts[1]) {
        handle_seek(g_ascii_strtod(parts[1], NULL));
      } else if (!g_strcmp0(parts[0], "GAIN") && parts[1]) {
        track_gain = CLAMP(g_ascii_strtod(parts[1], NULL), 0.0, 8.0);
        apply_track_gain(track_gain);
      } else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {
        /* VOLUME input is latest-value state, not an ordered transport command.
         * The stdin thread stores only the newest target; command_tick applies it
         * once per main-context wake. This prevents a burst of slider events from
         * repeatedly stepping the GStreamer volume property and is deliberately
         * separate from transport-command ordering. */
        const gdouble requested_volume = CLAMP(g_ascii_strtod(parts[1], NULL), 0.0, 1.0);
        latest_volume = requested_volume;
        pending_volume = TRUE;
      } else if (!g_strcmp0(parts[0], "MUTE") && parts[1]) {
        user_muted = g_ascii_strcasecmp(parts[1], "1") == 0;
        if (user_muted) {
          apply_output_mute(TRUE);
          trace_line("MUTE_STATE", "user_muted=1 sink_muted=1");
        } else if (stream_started && playing_state) {
          apply_output_mute(FALSE);
          set_user_volume(user_volume);
          trace_line("MUTE_STATE", "user_muted=0 sink_muted=0");
        } else {
          apply_output_mute(FALSE);
          trace_line("MUTE_DEFERRED", "user_muted=0 waiting_for=STREAM_START+PLAYING");
        }
      } else if (!g_strcmp0(parts[0], "TRACE") && parts[1]) {
        trace_enabled = g_ascii_strcasecmp(parts[1], "1") == 0;
        trace_line("TRACE_STATE", trace_enabled ? "enabled=1" : "enabled=0");
      } else if (!g_strcmp0(parts[0], "QUIT")) {
        shutting_down = TRUE;
        g_main_loop_quit(loop);
      }
    }
    g_strfreev(parts);
    g_free(line);
    if (stop_draining) break;
  }

  if (pending_volume) {
    const gdouble requested_volume = CLAMP(latest_volume, 0.0, 1.0);
    if (!user_muted) {
      /* The ramp is interpolated from inside a GstPadProbe on the volume
       * element's own sink pad (see volume_ramp_probe_cb) -- it only ever
       * runs when a buffer actually flows through that pad. While paused,
       * no buffers flow, so a ramp started here would sit inert and the
       * requested volume would never actually apply until playback resumed
       * (real bug, confirmed live: changing the slider while paused had no
       * audible effect until pressing Play again). There is also no output
       * to pop while paused, so there's nothing the ramp needs to protect
       * against here -- apply directly instead of ramping.
       */
      if (playing_state) begin_user_volume_ramp(requested_volume);
      else { cancel_user_volume_ramp(); set_user_volume(requested_volume); }
    }
    else { cancel_user_volume_ramp(); user_volume = requested_volume; }
    if (trace_enabled) { char detail[160]; snprintf(detail, sizeof(detail), "value=%.6f muted=%d stream_volume=hive-user-volume ramp=50ms", user_volume, user_muted); trace_line("VOLUME_STATE", detail); }
  }
  /* One-shot: the stdin thread schedules a new tick for every new burst of
   * commands. This used to return G_SOURCE_CONTINUE, which kept the idle
   * callback firing forever -- the helper pinned a whole CPU core (measured
   * ~98%) for as long as it ran. */
  return G_SOURCE_REMOVE;
}

/* Reads one command line of any length (portable: Windows has no getline). */
static gboolean read_command_line(GString *line) {
  char chunk[4096];
  g_string_truncate(line, 0);
  while (fgets(chunk, sizeof(chunk), stdin)) {
    g_string_append(line, chunk);
    if (line->len && line->str[line->len - 1] == '\n') return TRUE;
  }
  return line->len > 0;
}

static gpointer stdin_thread(gpointer unused) {
  (void)unused;
  GString *line = g_string_new(NULL);
  while (!shutting_down && read_command_line(line)) {
    g_strstrip(line->str); /* also drops a Windows \r */
    if (!*line->str) continue;
    g_async_queue_push(commands, g_strdup(line->str));

    /* Wake the GLib main context immediately instead of waiting for the old
     * 5 ms command timer. Coalesce wakeups: command_tick() drains everything
     * already queued, so one pending callback is enough for a burst of slider
     * input. */
    if (g_atomic_int_compare_and_exchange(&command_dispatch_pending, 0, 1)) {
      g_main_context_invoke(NULL, command_tick, NULL);
    }
  }
  g_string_free(line, TRUE);
  /* stdin reaching EOF means Hive itself is gone (closed, crashed or killed)
   * without sending QUIT. Exit instead of lingering as an orphan that keeps
   * the audio device open -- in bit-perfect mode that held the DAC away from
   * the rest of the system after Hive had closed. */
  if (!shutting_down) {
    g_async_queue_push(commands, g_strdup("QUIT"));
    if (g_atomic_int_compare_and_exchange(&command_dispatch_pending, 0, 1)) {
      g_main_context_invoke(NULL, command_tick, NULL);
    }
  }
  return NULL;
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  trace_enabled = g_getenv("HIVE_GST_TRACE") && g_strcmp0(g_getenv("HIVE_GST_TRACE"), "1") == 0;
#ifdef G_OS_WIN32
  /* Windows has no reliable inherited fd 3, so events go to stdout (nothing
   * else writes there; GStreamer's own logging uses stderr). Binary mode keeps
   * "\n" line endings exact. */
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  event_fp = stdout;
#else
  event_fp = fdopen(3, "w");
#endif
  commands = g_async_queue_new();
  g_mutex_init(&next_lock);
  loop = g_main_loop_new(NULL, FALSE);

  player = gst_element_factory_make("playbin3", "player");
  if (!player) player = gst_element_factory_make("playbin", "player");
  if (!player) { event_line("ERROR", "GStreamer playbin/playbin3 unavailable"); return 2; }

  const gchar *requested_output = g_getenv("HIVE_AUDIO_OUTPUT_DEVICE");
  GstElement *sink = NULL;
  gboolean sink_is_pulse = FALSE;
  if (requested_output && g_str_has_prefix(requested_output, "alsa:")) {
    GstElement *alsa_sink = gst_element_factory_make("alsasink", "audio-output");
    if (alsa_sink) {
      g_object_set(alsa_sink, "device", requested_output + 5, NULL);
      sink = alsa_sink;
      bit_perfect = TRUE;
      event_line("OUTPUT_DEVICE", requested_output);
      event_line("BIT_PERFECT", requested_output + 5);
    } else {
      event_line("OUTPUT_DEVICE_FALLBACK", "alsasink unavailable; bit-perfect output disabled, using system default");
    }
    requested_output = NULL;
  }
  if (requested_output && *requested_output) {
    GstElement *pulse_sink = gst_element_factory_make("pulsesink", "audio-output");
    if (pulse_sink) {
      g_object_set(pulse_sink, "device", requested_output, NULL);
      sink = pulse_sink;
      sink_is_pulse = TRUE;
      event_line("OUTPUT_DEVICE", requested_output);
    } else {
      event_line("OUTPUT_DEVICE_FALLBACK", "selected output unavailable; using system default");
    }
  }
  if (!sink) {
    /* Prefer pulsesink explicitly over autoaudiosink's own auto-pick here,
     * NOT to route the user-volume ramp through it (that was tried and
     * reverted -- see begin_user_volume_ramp's comment) but for a narrower,
     * one-time reason: without an explicit "volume" property write,
     * PipeWire's pulse-compat layer assigns a brand-new stream whatever its
     * own session-manager default is (observed on the target desktop:
     * starts at 50%, not 100%), so the OS mixer/sound-settings entry for
     * this app shows a misleading level even while Hive's own in-app
     * hive-user-volume element -- the sole real volume control -- is at
     * unity. Force this stream's own volume/mute to unity/unmuted once at
     * startup so the system mixer always reads 100% and every bit of actual
     * gain control stays in hive-user-volume, matching the architecture
     * elsewhere in this file. Fall back to autoaudiosink, which exposes no
     * "volume"/"mute" properties to pin the same way, only if pulsesink is
     * genuinely unavailable. */
    GstElement *pulse_sink = gst_element_factory_make("pulsesink", "audio-output");
    if (pulse_sink) {
      sink = pulse_sink;
      sink_is_pulse = TRUE;
      event_line("OUTPUT_DEVICE", "system-default");
    } else {
      sink = gst_element_factory_make("autoaudiosink", "audio-output");
      if (!sink) { event_line("ERROR", "GStreamer autoaudiosink unavailable"); return 3; }
      event_line("OUTPUT_DEVICE", "system-default");
    }
  }
  if (sink_is_pulse) g_object_set(sink, "volume", 1.0, "mute", FALSE, NULL);

  /* playbin inserts its own internal queue (default ~1 second) between the
   * audio-filter chain and the audio-sink slot. A gain change applied
   * upstream of that queue (i.e. inside "audio-filter") has to wait for a
   * queue's worth of already-buffered, old-volume audio to drain before it
   * is audible — a real, reported ~1s lag between moving the slider and
   * hearing it. hive-user-volume therefore lives in its own bin assigned to
   * "audio-sink" instead, immediately upstream of the real sink and
   * downstream of that queue, so a gain change applies to whatever is about
   * to be rendered next, not to something already queued. ReplayGain
   * (constant per track, not something the user drags in real time) and the
   * spectrum analyzer stay upstream in "audio-filter" where queue latency
   * does not matter. */
  GstElement *sink_bin = bit_perfect ? NULL : gst_bin_new("hive-audio-sink");
  user_volume_element = bit_perfect ? NULL : gst_element_factory_make("volume", "hive-user-volume");
  if (bit_perfect) {
    /* No user-volume element: set_user_volume() and the ramp become no-ops,
     * and playbin only inserts format conversion the hardware actually needs
     * (e.g. 16-bit into a 32-bit-only DAC, which is lossless padding). */
    g_object_set(player, "audio-sink", sink, NULL);
  } else if (sink_bin && user_volume_element) {
    gst_bin_add_many(GST_BIN(sink_bin), user_volume_element, sink, NULL);
    if (gst_element_link(user_volume_element, sink)) {
      g_object_set(G_OBJECT(user_volume_element), "volume", MAX(user_volume, USER_VOLUME_ELEMENT_FLOOR), NULL);
      GstPad *sink_pad = gst_element_get_static_pad(user_volume_element, "sink");
      /* Drives the ramp: see volume_ramp_probe_cb's comment above for why a
       * per-buffer probe on this exact pad replaces an external timer. */
      gst_pad_add_probe(sink_pad, GST_PAD_PROBE_TYPE_BUFFER, volume_ramp_probe_cb, NULL, NULL);
      GstPad *ghost_sink = gst_ghost_pad_new("sink", sink_pad);
      gst_object_unref(sink_pad);
      if (ghost_sink) gst_element_add_pad(sink_bin, ghost_sink);
      g_object_set(player, "audio-sink", sink_bin, NULL);
    } else {
      g_object_set(player, "audio-sink", sink, NULL);
    }
  } else {
    g_object_set(player, "audio-sink", sink, NULL);
  }

  /* Keep ReplayGain and visualization inside GStreamer's authoritative audio
   * path, upstream of the user-volume/sink bin above. */
  audio_filter_bin = gst_bin_new("hive-audio-filter");
  track_gain_element = gst_element_factory_make("volume", "hive-track-gain");
  spectrum = gst_element_factory_make("spectrum", "hive-spectrum");
  if (audio_filter_bin && track_gain_element && spectrum) {
    g_object_set(spectrum, "bands", 64, "interval", (gint64)50000000,
      "threshold", -80, "post-messages", TRUE, NULL);
    gst_bin_add_many(GST_BIN(audio_filter_bin), track_gain_element, spectrum, NULL);
    if (gst_element_link(track_gain_element, spectrum)) {
      GstPad *sink_pad = gst_element_get_static_pad(track_gain_element, "sink");
      GstPad *src_pad = gst_element_get_static_pad(spectrum, "src");
      GstPad *ghost_sink = gst_ghost_pad_new("sink", sink_pad);
      GstPad *ghost_src = gst_ghost_pad_new("src", src_pad);
      gst_object_unref(sink_pad);
      gst_object_unref(src_pad);
      if (ghost_sink && ghost_src && gst_element_add_pad(audio_filter_bin, ghost_sink)) {
        if (gst_element_add_pad(audio_filter_bin, ghost_src)) {
          g_object_set(player, "audio-filter", audio_filter_bin, NULL);
        } else {
          gst_element_remove_pad(audio_filter_bin, ghost_sink);
          gst_object_unref(ghost_src);
        }
      } else {
        if (ghost_sink) gst_object_unref(ghost_sink);
        if (ghost_src) gst_object_unref(ghost_src);
      }
    }
  }
  /* Ordinary volume is applied entirely by hive-user-volume above now, so
   * playbin does not need to insert or forward to any volume stage of its
   * own; leave its soft-volume flag cleared and its own "volume" property
   * untouched at the default (unity). */
  gint playbin_flags = 0;
  g_object_get(player, "flags", &playbin_flags, NULL);
  playbin_flags &= ~HIVE_PLAY_FLAG_SOFT_VOLUME;
  g_object_set(player, "flags", playbin_flags, NULL);
  apply_track_gain(track_gain);
  apply_output_mute(FALSE);
  g_signal_connect(player, "about-to-finish", G_CALLBACK(about_to_finish_cb), NULL);

  GstBus *bus = gst_element_get_bus(player);
  gst_bus_add_watch(bus, bus_cb, NULL);
  gst_object_unref(bus);

  GThread *tin = g_thread_new("hive-stdin", stdin_thread, NULL);
  g_timeout_add(100, position_tick, NULL);

  trace_line("READY", "helper_initialized=1");
  event_line("READY", NULL);
  g_main_loop_run(loop);
  shutting_down = TRUE;
  gst_element_set_state(player, GST_STATE_NULL);
  g_thread_join(tin);
  g_clear_pointer(&next_uri, g_free);
  g_async_queue_unref(commands);
  g_main_loop_unref(loop);
  if (audio_filter_bin) {
    g_object_set(player, "audio-filter", NULL, NULL);
    g_clear_object(&audio_filter_bin);
    spectrum = NULL;
    track_gain_element = NULL;
    user_volume_element = NULL;
  }
  g_object_unref(player);
  if (event_fp) fclose(event_fp);
  return 0;
}
