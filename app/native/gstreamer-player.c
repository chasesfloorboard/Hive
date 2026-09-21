/* Beehive GStreamer backend.
 *
 * GStreamer owns the complete playback pipeline, clock, buffering, decoding,
 * audio output, seeking, and gapless next-track transition.  The Electron
 * renderer only sends transport commands and receives lightweight state
 * events; PCM is never copied through Electron IPC.
 */
#include <gst/gst.h>
#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <math.h>

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
static GstElement *spectrum = NULL;
static GstElement *track_gain_element = NULL;
static GstElement *user_volume_element = NULL;
static GstElement *audio_filter_bin = NULL;

static void event_line(const char *name, const char *arg);

/* Ordinary user volume is applied directly to the dedicated in-pipeline
 * GStreamer volume element. The slider is already sending each input event
 * immediately, so there is no renderer debounce and no native timer/ramp to
 * reset on every mouse movement.
 *
 * The element stays in the audio-sink bin, immediately upstream of the real
 * sink. This placement is important: putting the user-volume element back in
 * playbin's audio-filter chain reintroduces the ~1 second queue latency that
 * the user reported. ReplayGain remains a separate upstream element.
 *
 * Startup/unmute use the same direct setter. Track transitions do not call
 * this function, so they do not acquire a user-volume ramp or delay. */
static void set_user_volume(gdouble value) {
  value = CLAMP(value, 0.0, 1.0);
  user_volume = value;
  if (!user_volume_element) return;
  g_object_set(G_OBJECT(user_volume_element), "volume", value, NULL);
}

static void apply_track_gain(gdouble value) {
  if (!track_gain_element) return;
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

static gboolean bus_cb(GstBus *bus, GstMessage *msg, gpointer unused) {
  switch (GST_MESSAGE_TYPE(msg)) {
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
      event_line("ERROR", "initial seek failed");
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

static gboolean command_tick(gpointer unused) {
  /* This callback is scheduled by the stdin reader whenever a command arrives.
   * It is deliberately event-driven rather than polled every 5 ms: slider
   * volume changes should reach GStreamer as soon as the command crosses the
   * process boundary, without adding a periodic control latency or building a
   * backlog of stale slider positions. */
  g_atomic_int_set(&command_dispatch_pending, 0);
  gboolean pending_volume = FALSE;
  gdouble latest_volume = user_volume;
  gchar *line;
  while ((line = g_async_queue_try_pop(commands)) != NULL) {
    gchar **parts = g_strsplit(line, "\t", 0);
    if (parts[0]) {
      if (trace_enabled) {
        if (!g_strcmp0(parts[0], "LOAD") && parts[1]) {
          gsize n=0; guchar *d=g_base64_decode(parts[1], &n); gchar *path=(d&&n)?g_strndup((const gchar*)d,n):g_strdup("<invalid>"); gchar *uri=path_to_uri(path); gchar *detail=g_strdup_printf("LOAD path=%s offset=%s start=%s end=%s", uri?uri:path, parts[2]?parts[2]:"0", parts[3]?parts[3]:"0", parts[4]?parts[4]:"0"); trace_line("COMMAND",detail); g_free(detail); g_free(uri); g_free(path); g_free(d);
        } else if (!g_strcmp0(parts[0], "NEXT") && parts[1]) trace_line("COMMAND", "NEXT");
        else if (parts[1]) { gchar *detail=g_strdup_printf("%s arg=%s",parts[0],parts[1]); trace_line("COMMAND",detail); g_free(detail); }
        else trace_line("COMMAND",parts[0]);
      }
      if (!g_strcmp0(parts[0], "LOAD") && parts[1]) {
        handle_load(parts[1], parts[2] ? g_ascii_strtod(parts[2], NULL) : 0.0,
          parts[3] ? g_ascii_strtod(parts[3], NULL) : 0.0,
          parts[4] ? g_ascii_strtod(parts[4], NULL) : 0.0);
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
  }

  if (pending_volume) {
    const gdouble requested_volume = CLAMP(latest_volume, 0.0, 1.0);
    if (!user_muted) set_user_volume(requested_volume);
    else user_volume = requested_volume;
    if (trace_enabled) { char detail[160]; snprintf(detail, sizeof(detail), "value=%.6f muted=%d stream_volume=hive-user-volume", user_volume, user_muted); trace_line("VOLUME_STATE", detail); }
  }
  return G_SOURCE_CONTINUE;
}

static void *stdin_thread(void *unused) {
  char *line = NULL; size_t cap = 0;
  while (!shutting_down && getline(&line, &cap, stdin) >= 0) {
    g_strchomp(line);
    if (!*line) continue;
    g_async_queue_push(commands, g_strdup(line));

    /* Wake the GLib main context immediately instead of waiting for the old
     * 5 ms command timer. Coalesce wakeups: command_tick() drains everything
     * already queued, so one pending callback is enough for a burst of slider
     * input. */
    if (g_atomic_int_compare_and_exchange(&command_dispatch_pending, 0, 1)) {
      g_main_context_invoke(NULL, command_tick, NULL);
    }
  }
  free(line);
  return NULL;
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  trace_enabled = g_getenv("HIVE_GST_TRACE") && g_strcmp0(g_getenv("HIVE_GST_TRACE"), "1") == 0;
  event_fp = fdopen(3, "w");
  commands = g_async_queue_new();
  g_mutex_init(&next_lock);
  loop = g_main_loop_new(NULL, FALSE);

  player = gst_element_factory_make("playbin3", "player");
  if (!player) player = gst_element_factory_make("playbin", "player");
  if (!player) { event_line("ERROR", "GStreamer playbin/playbin3 unavailable"); return 2; }

  const gchar *requested_output = g_getenv("HIVE_AUDIO_OUTPUT_DEVICE");
  GstElement *sink = NULL;
  if (requested_output && *requested_output) {
    GstElement *pulse_sink = gst_element_factory_make("pulsesink", "audio-output");
    if (pulse_sink) {
      g_object_set(pulse_sink, "device", requested_output, NULL);
      sink = pulse_sink;
      event_line("OUTPUT_DEVICE", requested_output);
    } else {
      event_line("OUTPUT_DEVICE_FALLBACK", "selected output unavailable; using system default");
    }
  }
  if (!sink) {
    sink = gst_element_factory_make("autoaudiosink", "audio-output");
    if (!sink) { event_line("ERROR", "GStreamer autoaudiosink unavailable"); return 3; }
    event_line("OUTPUT_DEVICE", "system-default");
  }

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
  GstElement *sink_bin = gst_bin_new("hive-audio-sink");
  user_volume_element = gst_element_factory_make("volume", "hive-user-volume");
  if (sink_bin && user_volume_element) {
    gst_bin_add_many(GST_BIN(sink_bin), user_volume_element, sink, NULL);
    if (gst_element_link(user_volume_element, sink)) {
      g_object_set(G_OBJECT(user_volume_element), "volume", user_volume, NULL);
      GstPad *sink_pad = gst_element_get_static_pad(user_volume_element, "sink");
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

  pthread_t tin;
  pthread_create(&tin, NULL, stdin_thread, NULL);
  g_timeout_add(100, position_tick, NULL);

  trace_line("READY", "helper_initialized=1");
  event_line("READY", NULL);
  g_main_loop_run(loop);
  shutting_down = TRUE;
  gst_element_set_state(player, GST_STATE_NULL);
  pthread_join(tin, NULL);
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
