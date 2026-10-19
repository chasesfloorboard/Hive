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
