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
}
