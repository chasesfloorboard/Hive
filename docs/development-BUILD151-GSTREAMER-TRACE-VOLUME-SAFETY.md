# Hive Build 151 — GStreamer trace + volume-unmute safety

## Reproduction

The uploaded `infinity (888) [feat. Joey Bada$$].m4a` reliably exposed a transport state where the track remained at 0:00/paused and later moving the volume control caused audio to begin playing. This is a valuable clue because the renderer's volume slider clears the logical mute state (`audio.muted = false`), which sends `MUTE 0` to the native transport.

## Root-cause fix

Build 150 allowed native `MUTE 0` to execute `g_object_set(player, "mute", FALSE, NULL)` whenever the transport was not yet in the validated `STREAM_START + PLAYING` state. That made a volume adjustment capable of opening the physical sink even though playback had not been validated.

Build 151 changes this boundary:

- `MUTE 0` only physically unmutes when both `stream_started` and `playing_state` are true.
- Otherwise the logical user mute state is updated but the physical sink remains muted.
- A later validated PLAYING transition is responsible for safely opening the sink.
- Volume changes remain volume-only operations and cannot become an implicit transport command.

## Diagnostics

Set `HIVE_GST_TRACE=1` when launching Hive. The native helper then records timestamped command, state, stream-start, mute, volume, and decoder-error diagnostics into the normal Hive session log. The main process also records renderer-to-GStreamer commands when tracing is enabled.

This intentionally remains opt-in because high-frequency native tracing should not be enabled during normal playback.

## Test procedure

1. Launch with `HIVE_GST_TRACE=1`.
2. Play a known-good track first and confirm normal playback.
3. Play the Joey Bada$$ M4A reproduction.
4. If it stalls at 0:00/paused, do not move the volume yet; inspect the session trace first if possible.
5. If needed, reproduce the volume-knob workaround. Build 151 should no longer allow that volume action to physically unmute a stalled native transport.
6. Try the next queue track and record whether `STREAM_START`, `PLAYING`, `PAUSED`, `ERROR`, `FATAL_ERROR`, and `MUTE_DEFERRED` appear in the expected order.
