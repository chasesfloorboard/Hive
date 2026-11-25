package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class SpectrumProcessorTest {
    @Test
    fun silenceProducesZeroBands() {
        val bands = SpectrumFft.compute64Bands(FloatArray(SpectrumFft.FFT_SIZE), 48_000)
        assertEquals(64, bands.size)
        assertTrue("all bands silent", bands.all { it == 0f })
    }

    @Test
    fun sineWavePeaksInExpectedFrequencyBand() {
        val rate = 48_000
        val low = FloatArray(SpectrumFft.FFT_SIZE) { i -> sin(2.0 * PI * 100.0 * i / rate).toFloat() }
        val high = FloatArray(SpectrumFft.FFT_SIZE) { i -> sin(2.0 * PI * 4000.0 * i / rate).toFloat() }

        val lowBands = SpectrumFft.compute64Bands(low, rate)
        val highBands = SpectrumFft.compute64Bands(high, rate)

        val lowPeakIdx = lowBands.indices.maxByOrNull { lowBands[it] } ?: -1
        val highPeakIdx = highBands.indices.maxByOrNull { highBands[it] } ?: -1

        assertTrue("100 Hz peak should be loud (${lowBands[lowPeakIdx]})", lowBands[lowPeakIdx] > 0.8f)
        assertTrue("4 kHz peak should be loud (${highBands[highPeakIdx]})", highBands[highPeakIdx] > 0.8f)
        assertTrue("100 Hz band ($lowPeakIdx) should be well below 4 kHz band ($highPeakIdx)", lowPeakIdx in 10..20 && highPeakIdx in 45..58)
    }

    @Test
    fun spectrumBusTracksObserverLifecycle() {
        assertEquals(false, SpectrumBus.active)
        SpectrumBus.acquire()
        assertEquals(true, SpectrumBus.active)
        SpectrumBus.acquire()
        SpectrumBus.release()
        assertEquals(true, SpectrumBus.active)
        SpectrumBus.release()
        assertEquals(false, SpectrumBus.active)
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    @Test
    fun processorAccepts24Bit32BitFloatAndPassesThroughExoticWithoutThrowing() {
        val proc = SpectrumProcessor()
        val f24 = androidx.media3.common.audio.AudioProcessor.AudioFormat(96_000, 2, androidx.media3.common.C.ENCODING_PCM_24BIT)
        val f32 = androidx.media3.common.audio.AudioProcessor.AudioFormat(192_000, 2, androidx.media3.common.C.ENCODING_PCM_32BIT)
        val fFloat = androidx.media3.common.audio.AudioProcessor.AudioFormat(48_000, 2, androidx.media3.common.C.ENCODING_PCM_FLOAT)
        val exotic = androidx.media3.common.audio.AudioProcessor.AudioFormat(48_000, 2, androidx.media3.common.C.ENCODING_PCM_8BIT)
        assertEquals(f24, proc.configure(f24))
        assertEquals(f32, proc.configure(f32))
        assertEquals(fFloat, proc.configure(fFloat))
        assertEquals(androidx.media3.common.audio.AudioProcessor.AudioFormat.NOT_SET, proc.configure(exotic))
    }
}
