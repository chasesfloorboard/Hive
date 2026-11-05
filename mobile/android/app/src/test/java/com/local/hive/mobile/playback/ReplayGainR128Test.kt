package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Test

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ReplayGainR128Test {
    @Test fun replayGainTagsWin() {
        assertEquals(0.5012f, ReplayGain.linear(mapOf("REPLAYGAIN_TRACK_GAIN" to "-6.00 dB", "R128_TRACK_GAIN" to "0"), "track", false), 0.001f)
    }

    /** Opus: R128 gains are Q7.8 dB relative to -23 LUFS; ReplayGain's -18 LUFS reference is 5 dB louder. */
    @Test fun r128IsUsedWhenThereIsNoReplayGain() {
        assertEquals(1f, ReplayGain.linear(mapOf("R128_TRACK_GAIN" to "-1280"), "track", false), 0.001f)
        assertEquals(0.5623f, ReplayGain.linear(mapOf("R128_TRACK_GAIN" to "-2560"), "track", false), 0.001f)
        assertEquals(1.7783f, ReplayGain.linear(mapOf("R128_TRACK_GAIN" to "0", "R128_ALBUM_GAIN" to "0"), "album", false), 0.001f)
    }

    @Test fun offMeansUnity() {
        assertEquals(1f, ReplayGain.linear(mapOf("R128_TRACK_GAIN" to "-2560"), "off", false), 0f)
    }
}
