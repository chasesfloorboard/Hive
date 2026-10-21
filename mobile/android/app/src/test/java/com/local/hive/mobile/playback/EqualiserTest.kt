package com.local.hive.mobile.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class EqualiserTest {
    private val rate = 44_100

    /** Peak level of a [hz] tone after the equaliser, relative to the input's. */
    private fun gainAt(hz: Double, preset: EqPreset?): Double {
        val eq = EqualiserProcessor()
        eq.configure(AudioProcessor.AudioFormat(rate, 1, C.ENCODING_PCM_FLOAT))
        eq.flush(AudioProcessor.StreamMetadata.DEFAULT)
        eq.setCurve(preset)
        val n = rate // one second
        val input = ByteBuffer.allocateDirect(n * 4).order(ByteOrder.nativeOrder())
        for (i in 0 until n) input.putFloat((0.1 * sin(2 * PI * hz * i / rate)).toFloat())
        input.flip()
        eq.queueInput(input)
        val out = eq.output
        var peak = 0.0
        var i = 0
        while (out.hasRemaining()) { val v = abs(out.getFloat().toDouble()); if (i > n / 2) peak = maxOf(peak, v); i++ }
        return peak / 0.1
    }

    private fun db(ratio: Double) = 20 * kotlin.math.log10(ratio)

    /** A crossfade's fade-in starts at the seek's flush: silent first, rising, then full, two channels alike. */
    @Test fun crossfadeFadesTheNextSongIn() {
        val eq = EqualiserProcessor()
        eq.configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT))
        eq.fadeInOnNextFlush(1000)
        eq.flush(AudioProcessor.StreamMetadata.DEFAULT)
        val frames = rate * 2
        val input = ByteBuffer.allocateDirect(frames * 2 * 4).order(ByteOrder.nativeOrder())
        repeat(frames * 2) { input.putFloat(0.5f) }
        input.flip()
        eq.queueInput(input)
        val out = eq.output
        val v = FloatArray(frames * 2) { out.getFloat() }
        assertEquals(0f, v[0], 1e-4f)
        assertEquals(v[0], v[1], 0f)
        assertEquals(0.5f * sin(PI / 4).toFloat(), v[rate], 0.01f) // halfway: equal power
        assertEquals(0.5f, v[2 * rate + 2], 1e-4f) // after a second, untouched
        assertEquals(0.5f, v.last(), 1e-4f)
        // A later flush (a plain seek) doesn't fade again.
        eq.flush(AudioProcessor.StreamMetadata.DEFAULT)
        val again = ByteBuffer.allocateDirect(8).order(ByteOrder.nativeOrder()).apply { putFloat(0.5f); putFloat(0.5f); flip() }
        eq.queueInput(again)
        assertEquals(0.5f, eq.output.getFloat(), 1e-4f)
    }

    @Test fun flatLeavesTheSignalAlone() = assertEquals(0.0, db(gainAt(1000.0, EqState.BUILT_IN.first())), 0.05)

    @Test fun aBandBoostsItsOwnFrequencyByItsGain() {
        val gains = MutableList(10) { 0f }.apply { this[5] = 6f } // 1 kHz
        assertEquals(6.0, db(gainAt(1000.0, EqPreset("t", 0f, gains))), 0.3)
        // Two octaves away the boost has mostly gone.
        assertEquals(0.0, db(gainAt(250.0, EqPreset("t", 0f, gains))), 1.0)
    }

    @Test fun preampScalesEverything() = assertEquals(-3.0, db(gainAt(440.0, EqPreset("t", -3f, List(10) { 0f }))), 0.05)

    @Test fun genreFindsItsPreset() {
        assertEquals("Hip-Hop", EqState.presetForGenre(EqState.BUILT_IN, "Hip Hop/Rap")?.name)
        assertNull(EqState.presetForGenre(EqState.BUILT_IN, "Podcast"))
    }

    @Test fun sdeRoundTrips() {
        val p = EqState.BUILT_IN.first { it.name == "Rock" }
        assertEquals(p, EqState.parseSde(EqState.serializeSde(p), "Rock"))
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ReplayGainTest {
    private val tags = mapOf("REPLAYGAIN_TRACK_GAIN" to "-6.02 dB", "REPLAYGAIN_TRACK_PEAK" to "0.98", "REPLAYGAIN_ALBUM_GAIN" to "+3.00 dB", "REPLAYGAIN_ALBUM_PEAK" to "0.5")

    @Test fun offAndUntaggedLeaveVolumeAlone() {
        assertEquals(1f, ReplayGain.linear(tags, "off", true), 0f)
        assertEquals(1f, ReplayGain.linear(emptyMap(), "track", true), 0f)
    }

    @Test fun trackGainIsApplied() = assertEquals(0.5f, ReplayGain.linear(tags, "track", true), 0.005f)

    @Test fun albumGainIsHeldUnderThePeak() {
        assertEquals(1.413f, ReplayGain.linear(tags, "album", false), 0.005f)
        assertEquals(1.413f, ReplayGain.linear(tags, "album", true), 0.005f) // 1/0.5 = 2 allows it
        assertEquals(1.0f, ReplayGain.linear(tags + ("REPLAYGAIN_ALBUM_PEAK" to "1.0"), "album", true), 0.005f)
    }

    @Test fun albumFallsBackToTrackGain() = assertEquals(0.5f, ReplayGain.linear(tags.filterKeys { !it.startsWith("REPLAYGAIN_ALBUM") }, "album", true), 0.005f)
}

class LastFmSignatureTest {
    // Last.fm's documented recipe: sorted name+value pairs, then the secret, md5'd; format is left out.
    @Test fun signatureMatchesTheRecipe() {
        val sig = com.local.hive.mobile.stream.Scrobbler.signature(mapOf("method" to "auth.getSession", "api_key" to "abc", "token" to "t1", "format" to "json"), "s3cret")
        val expected = java.security.MessageDigest.getInstance("MD5").digest("api_keyabcmethodauth.getSessiontokent1s3cret".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, sig)
    }
}
