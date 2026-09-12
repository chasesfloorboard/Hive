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

static GstElement *player = NULL;
static GMainLoop *loop = NULL;
static GAsyncQueue *commands = NULL;
static GMutex next_lock;
static gchar *next_uri = NULL;
static FILE *event_fp = NULL;
static gboolean shutting_down = FALSE;

/* Short volume ramps prevent an abrupt waveform discontinuity when transport
 * starts/stops.  The ramp is intentionally only 10 ms: it is effectively
 * inaudible as a fade, but long enough to suppress the click/pop that can
 * reach headphones when audio is switched on or off at a non-zero sample. */
#define TRANSPORT_RAMP_US 10000
static guint volume_ramp_source = 0;
static gboolean volume_ramp_down = FALSE;
static gint64 volume_ramp_started_us = 0;
static gdouble volume_ramp_from = 0.0;
static gdouble volume_target = 1.0; /* user-selected volume; never changed by transport ramps */

static void cancel_volume_ramp(void) {
  if (volume_ramp_source) {
    g_source_remove(volume_ramp_source);
    volume_ramp_source = 0;
  }
}

static gboolean volume_ramp_tick(gpointer unused) {
  if (!player || shutting_down) {
    volume_ramp_source = 0;
    return G_SOURCE_REMOVE;
  }

  const gint64 elapsed = g_get_monotonic_time() - volume_ramp_started_us;
  const gdouble t = CLAMP((gdouble)elapsed / (gdouble)TRANSPORT_RAMP_US, 0.0, 1.0);
  const gdouble end_volume = volume_ramp_down ? 0.0 : volume_target;
  const gdouble v = volume_ramp_from + ((end_volume - volume_ramp_from) * t);
  g_object_set(player, "volume", CLAMP(v, 0.0, 1.0), NULL);

  if (t >= 1.0) {
    volume_ramp_source = 0;
    if (volume_ramp_down) {
      /* Only pause after the fade reaches silence, so the audio sink never
       * has to stop at an arbitrary non-zero waveform sample. */
      gst_element_set_state(player, GST_STATE_PAUSED);
    }
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

static void start_volume_ramp(gdouble from, gdouble to, gboolean ramp_down) {
  cancel_volume_ramp();
  volume_ramp_from = CLAMP(from, 0.0, 1.0);
  /* IMPORTANT: volume_target is the user's desired volume.  A fade-to-zero
   * must never overwrite it, otherwise the next PLAY would correctly ramp
   * from zero to... zero.  This was the recurring pause -> play mute bug. */
  volume_ramp_down = ramp_down;
  volume_ramp_started_us = g_get_monotonic_time();
  volume_ramp_source = g_timeout_add(1, volume_ramp_tick, NULL);
  (void)to;
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
      event_line("ERROR", err ? err->message : "unknown GStreamer error");
      if (dbg) g_free(dbg);
      if (err) g_error_free(err);
      break;
    }
    case GST_MESSAGE_BUFFERING: {
      gint percent = 0;
      gst_message_parse_buffering(msg, &percent);
      char b[32]; snprintf(b, sizeof(b), "%d", percent);
      event_line("BUFFERING", b);
      break;
    }
    case GST_MESSAGE_STREAM_START:
      event_line("STREAM_START", NULL);
      break;
    case GST_MESSAGE_STATE_CHANGED:
      if (GST_MESSAGE_SRC(msg) == GST_OBJECT(player)) {
        GstState old_s, new_s, pending;
        gst_message_parse_state_changed(msg, &old_s, &new_s, &pending);
        if (new_s == GST_STATE_PLAYING) event_line("PLAYING", NULL);
        else if (new_s == GST_STATE_PAUSED) event_line("PAUSED", NULL);
      }
      break;
    default: break;
  }
  return G_SOURCE_CONTINUE;
}

static void handle_load(const gchar *b64, gdouble offset) {
  gsize len = 0;
  guchar *decoded = g_base64_decode(b64, &len);
  if (!decoded || len == 0) { g_free(decoded); event_line("ERROR", "invalid path"); return; }
  gchar *path = g_strndup((const gchar*)decoded, len);
  g_free(decoded);
  gchar *uri = path_to_uri(path);
  if (!uri) { g_free(path); event_line("ERROR", "cannot make file URI"); return; }

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
  gst_element_get_state(player, NULL, NULL, 8 * GST_SECOND);

  if (offset > 0.000001) {
    gint64 pos = (gint64)(offset * GST_SECOND);
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
  gint64 pos = (gint64)(MAX(0.0, offset) * GST_SECOND);
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
    char b[64]; snprintf(b, sizeof(b), "%.6f", (double)pos / (double)GST_SECOND);
    event_line("POSITION", b);
  }
  return G_SOURCE_CONTINUE;
}

static gboolean command_tick(gpointer unused) {
  gchar *line;
  while ((line = g_async_queue_try_pop(commands)) != NULL) {
    gchar **parts = g_strsplit(line, "\t", 0);
    if (parts[0]) {
      if (!g_strcmp0(parts[0], "LOAD") && parts[1]) {
        handle_load(parts[1], parts[2] ? g_ascii_strtod(parts[2], NULL) : 0.0);
      } else if (!g_strcmp0(parts[0], "NEXT") && parts[1]) {
        gsize len = 0; guchar *d = g_base64_decode(parts[1], &len);
        if (d && len) { gchar *path = g_strndup((const gchar*)d, len); set_next_path(path); g_free(path); }
        g_free(d);
      } else if (!g_strcmp0(parts[0], "PLAY")) {
        /* GStreamer owns the transport state.  Enter PLAYING immediately, then
         * make the first 10 ms of audible output ramp from the current sink
         * volume to the user's requested volume.  This covers both ordinary
         * pause -> play and a fresh double-click/load without a waveform pop. */
        gdouble current_volume = 0.0;
        g_object_get(player, "volume", &current_volume, NULL);
        const gdouble target = CLAMP(volume_target, 0.0, 1.0);
        gst_element_set_state(player, GST_STATE_PLAYING);
        start_volume_ramp(current_volume, target, FALSE);
      } else if (!g_strcmp0(parts[0], "PAUSE")) {
        /* Fade the actual sink volume to silence, but preserve volume_target so
         * the next PLAY knows where to ramp back up. */
        gdouble current_volume = 0.0;
        g_object_get(player, "volume", &current_volume, NULL);
        start_volume_ramp(current_volume, 0.0, TRUE);
      } else if (!g_strcmp0(parts[0], "RAMPSTART")) {
        /* Fresh LOAD is prerolling in PAUSED. Put the sink at silence without
         * touching volume_target, then PLAY will ramp to the user's volume. */
        cancel_volume_ramp();
        g_object_set(player, "volume", 0.0, NULL);
      } else if (!g_strcmp0(parts[0], "SEEKPLAY") && parts[1]) {
        handle_seek(g_ascii_strtod(parts[1], NULL));
        /* A FLUSH seek may transiently preroll PAUSED. Explicitly restore the
         * native PLAYING state after the seek so releasing a playing scrubber
         * can never leave transport paused. */
        gst_element_set_state(player, GST_STATE_PLAYING);
      } else if (!g_strcmp0(parts[0], "STOP")) {
        gst_element_set_state(player, GST_STATE_READY);
      } else if (!g_strcmp0(parts[0], "SEEK") && parts[1]) {
        handle_seek(g_ascii_strtod(parts[1], NULL));
      } else if (!g_strcmp0(parts[0], "VOLUME") && parts[1]) {
        gdouble v = CLAMP(g_ascii_strtod(parts[1], NULL), 0.0, 1.0);
        volume_target = v;
        /* User volume changes should remain immediate.  A transport ramp is
         * only about the Play/Pause transition itself. */
        cancel_volume_ramp();
        g_object_set(player, "volume", v, NULL);
      } else if (!g_strcmp0(parts[0], "MUTE") && parts[1]) {
        g_object_set(player, "mute", g_ascii_strcasecmp(parts[1], "1") == 0, NULL);
      } else if (!g_strcmp0(parts[0], "QUIT")) {
        shutting_down = TRUE;
        g_main_loop_quit(loop);
      }
    }
    g_strfreev(parts);
    g_free(line);
  }
  return G_SOURCE_CONTINUE;
}

static void *stdin_thread(void *unused) {
  char *line = NULL; size_t cap = 0;
  while (!shutting_down && getline(&line, &cap, stdin) >= 0) {
    g_strchomp(line);
    if (*line) g_async_queue_push(commands, g_strdup(line));
  }
  free(line);
  return NULL;
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);
  event_fp = fdopen(3, "w");
  commands = g_async_queue_new();
  g_mutex_init(&next_lock);
  loop = g_main_loop_new(NULL, FALSE);

  player = gst_element_factory_make("playbin3", "player");
  if (!player) player = gst_element_factory_make("playbin", "player");
  if (!player) { event_line("ERROR", "GStreamer playbin/playbin3 unavailable"); return 2; }

  GstElement *sink = gst_element_factory_make("autoaudiosink", "audio-output");
  if (!sink) { event_line("ERROR", "GStreamer autoaudiosink unavailable"); return 3; }
  g_object_set(player, "audio-sink", sink, NULL);
  volume_target = 1.0;
  g_object_set(player, "volume", volume_target, "mute", FALSE, NULL);
  g_signal_connect(player, "about-to-finish", G_CALLBACK(about_to_finish_cb), NULL);

  GstBus *bus = gst_element_get_bus(player);
  gst_bus_add_watch(bus, bus_cb, NULL);
  gst_object_unref(bus);

  pthread_t tin;
  pthread_create(&tin, NULL, stdin_thread, NULL);
  g_timeout_add(20, command_tick, NULL);
  g_timeout_add(100, position_tick, NULL);

  event_line("READY", NULL);
  g_main_loop_run(loop);
  shutting_down = TRUE;
  cancel_volume_ramp();
  gst_element_set_state(player, GST_STATE_NULL);
  pthread_join(tin, NULL);
  g_clear_pointer(&next_uri, g_free);
  g_async_queue_unref(commands);
  g_main_loop_unref(loop);
  g_object_unref(player);
  if (event_fp) fclose(event_fp);
  return 0;
}
