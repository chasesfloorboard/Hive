package com.local.hive.mobile.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class DeviceRateCapTest {
    private fun fmt(rate: Int, encoding: Int = C.ENCODING_PCM_16BIT) =
        AudioProcessor.AudioFormat(rate, 2, encoding)

    /** 44.1 and 48 kHz (the ordinary library) pass straight through: inactive, format unchanged. */
    @Test fun leavesDeviceRateAndBelowUntouched() {
        val cap = DeviceRateCap()
        for (rate in intArrayOf(44_100, 48_000)) {
            val out = cap.configure(fmt(rate))
            assertFalse("$rate Hz should not be resampled", cap.isActive())
            assertEquals(rate, out.sampleRate)
        }
    }

    /** Hi-res is capped to 48 kHz so the AudioTrack never opens above the device rate. */
    @Test fun capsHiResToFortyEightK() {
        val cap = DeviceRateCap()
        for (rate in intArrayOf(88_200, 96_000, 192_000)) {
            val out = cap.configure(fmt(rate))
            assertTrue("$rate Hz should be resampled", cap.isActive())
            assertEquals(48_000, out.sampleRate)
        }
    }

    /** A custom cap value is honoured (e.g. a 44.1 kHz-native route). */
    @Test fun honoursCustomCap() {
        val cap = DeviceRateCap(maxHz = 44_100)
        assertEquals(44_100, cap.configure(fmt(48_000)).sampleRate)
        assertTrue(cap.isActive())
        assertFalse(DeviceRateCap(maxHz = 44_100).let { it.configure(fmt(44_100)); it.isActive() })
    }

    /** Reconfiguring from a hi-res song back to a CD-rate one flips it inactive again. */
    @Test fun reconfiguringBackToDeviceRateDeactivates() {
        val cap = DeviceRateCap()
        cap.configure(fmt(96_000))
        assertTrue(cap.isActive())
        cap.configure(fmt(44_100))
        assertFalse(cap.isActive())
    }

    /** End to end: 96 kHz 16-bit stereo in, ~half the frames out at 48 kHz, no error. */
    @Test fun resamplesNinetySixToFortyEightByHalf() {
        val cap = DeviceRateCap()
        cap.configure(fmt(96_000))
        cap.flush(AudioProcessor.StreamMetadata.DEFAULT)
        val inFrames = 96_000 // one second
        val input = ByteBuffer.allocateDirect(inFrames * 4).order(ByteOrder.nativeOrder())
        for (i in 0 until inFrames) { input.putShort(0); input.putShort(0) } // silence is fine for a count
        input.flip()
        cap.queueInput(input)
        while (input.hasRemaining()) { drainOnce(cap); cap.queueInput(input) }
        cap.queueEndOfStream()
        var outBytes = 0
        while (!cap.isEnded()) outBytes += drainOnce(cap)
        val outFrames = outBytes / 4
        // ~48000 frames; allow Sonic's small block latency.
        assertEquals(48_000.0, outFrames.toDouble(), 48_000 * 0.02)
    }

    private fun drainOnce(cap: DeviceRateCap): Int {
        val o = cap.getOutput()
        val n = o.remaining()
        o.position(o.limit())
        return n
    }
}
