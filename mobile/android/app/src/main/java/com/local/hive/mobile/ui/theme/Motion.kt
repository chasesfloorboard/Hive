package com.local.hive.mobile.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween

/**
 * One UI's motion, as Samsung Music ships it (curves and durations read from
 * its interpolator and anim resources): screens slide in on a fast-out curve
 * in 450 ms and leave in 400 ms while the screen underneath fades in 150 ms;
 * the player fades over 400/250 ms; small art swaps cross-fade in 250 ms.
 */
object Motion {
    /** interpolator_022_05_0_1: screens opening. */
    val Open = CubicBezierEasing(0.22f, 0.5f, 0f, 1f)
    /** interpolator_022_025_0_1: screens closing, menus growing in. */
    val Close = CubicBezierEasing(0.22f, 0.25f, 0f, 1f)
    /** sine in-out 60: the player appearing. */
    val SineInOut60 = CubicBezierEasing(0.33f, 0f, 0.4f, 1f)
    /** sine in-out 33: symmetric fades and swaps. */
    val SineInOut33 = CubicBezierEasing(0.33f, 0f, 0.67f, 1f)
    /** sine in-out 80: One UI's general movement. */
    val SineInOut80 = CubicBezierEasing(0.33f, 0f, 0.2f, 1f)
    val SineOut90 = CubicBezierEasing(0.17f, 0.17f, 0.1f, 1f)

    const val OPEN_MS = 450
    const val CLOSE_MS = 400
    /** Going back: quicker than opening, so it never feels like waiting. */
    const val BACK_MS = 280
    /** Starts fast and settles softly (Material's emphasised decelerate). */
    val Back = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    const val UNDER_FADE_MS = 150
    const val SWAP_MS = 250

    /**
     * How long the player takes to settle after a drag, as Samsung Music's
     * SlideGestureController computes it: 350 ms, shortened by flick speed
     * (clamped to 5,000–15,000 px/s) and never under 50 ms.
     */
    fun settleMs(velocityPxPerSec: Float): Int {
        val speed = kotlin.math.abs(velocityPxPerSec)
        if (speed < 1f) return 350
        val clamped = speed.coerceIn(5_000f, 15_000f)
        return (350f / (clamped / 5_000f)).toInt().coerceAtLeast(50)
    }

    fun <T> open() = tween<T>(OPEN_MS, easing = Open)
    fun <T> close() = tween<T>(CLOSE_MS, easing = Close)
    fun <T> back() = tween<T>(BACK_MS, easing = Back)
    fun <T> underFade() = tween<T>(UNDER_FADE_MS, easing = LinearEasing)
    fun <T> swap() = tween<T>(SWAP_MS, easing = SineInOut33)
    fun <T> move(ms: Int = 350) = tween<T>(ms, easing = SineInOut80)
}
