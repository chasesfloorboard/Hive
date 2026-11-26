package com.local.hive.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VisualizerShaperTest {
    @Test
    fun silenceStaysFlatAndPeakReachesFullHeightWithMonstercatSpread() {
        val shaper = VisualizerShaper()
        val silent = shaper.shapeFrame(FloatArray(64), barCount = 63, sensitivityDb = 35f, monstercatSmoothing = true, dtSeconds = 1f / 60f)
        assertEquals(63, silent.size)
        assertTrue("silence stays at 0", silent.all { it == 0f })

        val impulse = FloatArray(64).apply { this[20] = 0.95f }
        val bars = shaper.shapeFrame(impulse, barCount = 63, sensitivityDb = 35f, monstercatSmoothing = true, dtSeconds = 1f / 60f)
        val peakIdx = bars.indices.maxByOrNull { bars[it] } ?: -1
        assertTrue("peak bar reaches near full height (${bars[peakIdx]})", bars[peakIdx] > 0.9f)

        val spread = shaper.monstercatSpread(FloatArray(10).apply { this[5] = 1f }, factor = 1.5f)
        assertEquals(1f, spread[5], 0.001f)
        assertEquals(1f / 1.5f, spread[4], 0.01f)
        assertEquals(1f / 1.5f, spread[6], 0.01f)
        assertEquals(1f / 2.25f, spread[3], 0.01f)
    }

    @Test
    fun barsRiseQuicklyAndDecaySmoothly() {
        val shaper = VisualizerShaper()
        val risen = shaper.stepBars(FloatArray(16), FloatArray(16) { 1f }, dtSeconds = 0.016f, decayMs = 90f)
        assertTrue("fast attack reaches > 0.7 in 16ms (${risen[0]})", risen[0] > 0.7f)

        val fallen = shaper.stepBars(FloatArray(16) { 1f }, FloatArray(16) { 0f }, dtSeconds = 0.016f, decayMs = 90f)
        assertTrue("decay drops smoothly between 0.7 and 0.95 (${fallen[0]})", fallen[0] in 0.7f..0.95f)
    }

    @Test
    fun sweepingKickCrestRollsLeftWithFallingTrailingEdge() {
        val shaper = VisualizerShaper()
        var state = FloatArray(48)
        val bandPositions = listOf(18, 15, 12, 9, 6, 4, 3)
        val peaks = mutableListOf<Int>()
        for (centerBand in bandPositions) {
            val levels = FloatArray(64) { b ->
                val dist = kotlin.math.abs(b - centerBand)
                // Realistic Hann-width kick peak (~6 dB down 2 bands away, ~16 dB down 5 bands away)
                (0.92f - dist * 0.055f).coerceAtLeast(0.15f)
            }
            val target = shaper.shapeFrame(levels, barCount = 48, sensitivityDb = 35f, monstercatSmoothing = true, dtSeconds = 0.016f)
            state = shaper.stepBars(state, target, dtSeconds = 0.016f, decayMs = 90f)
            peaks += state.indices.maxByOrNull { state[it] } ?: -1
        }
        assertTrue("crest starts on right side of bass (${peaks.first()})", peaks.first() >= 12)
        assertTrue("crest rolls left to sub-bass (${peaks.last()})", peaks.last() <= 3)
        for (i in 1 until peaks.size) {
            assertTrue("crest moves monotonically right-to-left: $peaks", peaks[i] <= peaks[i - 1])
        }
        // Once the crest reaches bar <= 3, the starting punch bar (~13) has fallen well below the crest (wave, not block).
        val crestHeight = state[peaks.last()]
        assertTrue("trailing edge (${state[13]}) fell well below crest ($crestHeight)", state[13] < crestHeight * 0.55f)
    }
}
