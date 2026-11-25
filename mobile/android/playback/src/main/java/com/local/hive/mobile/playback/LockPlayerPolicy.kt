package com.local.hive.mobile.playback

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.PowerManager
import android.view.Display

/** Transition of the phone's built-in screen (Display 0), independent of Android Auto virtual displays. */
enum class DisplayTransition { NONE, TURNED_ON, TURNED_OFF }

/**
 * Pure, testable decision rules for Hive's lock-screen player.
 *
 * Android Auto creates active virtual displays that keep global PowerManager.mWakefulness == Awake
 * for the entire drive, which suppresses ACTION_SCREEN_ON / ACTION_SCREEN_OFF broadcasts even as the
 * phone's own screen (Display.DEFAULT_DISPLAY) sleeps and wakes for taps or notifications.
 * Tracking Display.DEFAULT_DISPLAY directly and bounding wake-transition re-assertions solves both
 * car invisibility and notification-wake cover-ups without ever waking a sleeping screen.
 */
object LockPlayerPolicy {
    /** Matches android.view.Display.STATE_ON (constant integer so pure JVM unit tests need no stub). */
    const val STATE_ON = 2

    /** Window after opening in which a SystemUI notification/keyguard takeover may be re-asserted once. */
    const val REASSERT_WINDOW_MS = 2_000L

    /** Maximum automatic re-assertions per screen wake (1 makes wake loops mathematically impossible). */
    const val MAX_REASSERT_ATTEMPTS = 1

    /** Delay before the single bounded re-assert so SystemUI's notification/AOD wake animation settles. */
    const val REASSERT_DELAY_MS = 350L

    /** Coalesces DisplayListener(STATE_ON) and ACTION_SCREEN_ON firing milliseconds apart on the same wake. */
    const val DUPLICATE_WAKE_DEBOUNCE_MS = 350L

    fun classifyDisplayTransition(previousState: Int, currentState: Int): DisplayTransition {
        val wasOn = previousState == STATE_ON
        val nowOn = currentState == STATE_ON
        return when {
            !wasOn && nowOn -> DisplayTransition.TURNED_ON
            wasOn && !nowOn -> DisplayTransition.TURNED_OFF
            else -> DisplayTransition.NONE
        }
    }

    /**
     * Whether LockPlayerActivity should schedule a single bounded re-assert after being pushed behind
     * the lock screen shortly after opening (e.g. when a notification wakes AOD/lock screen and
     * SystemUI finishes its wake transition ~50–150 ms after Display 0 turns on).
     */
    fun shouldReassertOnStop(
        isLocked: Boolean,
        displayOn: Boolean,
        leaving: Boolean,
        sentAway: Boolean,
        inCall: Boolean,
        elapsedSinceOpenMs: Long,
        reassertAttempts: Int,
    ): Boolean =
        isLocked &&
            displayOn &&
            !leaving &&
            !sentAway &&
            !inCall &&
            elapsedSinceOpenMs in 0..REASSERT_WINDOW_MS &&
            reassertAttempts < MAX_REASSERT_ATTEMPTS

    /**
     * When playback begins while the phone is locked AND its built-in screen is already ON (for example,
     * plugging into the car or receiving a notification wakes the lock screen 1–3 s before Android Auto
     * auto-resumes music), raise the lock player. Never raises when Display 0 is off/dozing.
     */
    fun shouldShowOnPlayStart(isPlaying: Boolean, isLocked: Boolean, displayOn: Boolean): Boolean =
        isPlaying && isLocked && displayOn

    /** Ground truth of whether the phone's own built-in screen (Display 0) is currently ON (not OFF/DOZE). */
    fun isDefaultDisplayOn(context: Context): Boolean {
        val dm = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        val display = dm?.getDisplay(Display.DEFAULT_DISPLAY)
        if (display != null) return display.state == Display.STATE_ON
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return pm?.isInteractive == true
    }

    /** Readable name for Display.state in diagnostic car-log entries. */
    fun displayStateName(state: Int): String = when (state) {
        Display.STATE_OFF -> "off"
        Display.STATE_ON -> "on"
        Display.STATE_DOZE -> "doze"
        Display.STATE_DOZE_SUSPEND -> "doze_suspend"
        Display.STATE_ON_SUSPEND -> "on_suspend"
        else -> "state_$state"
    }
}
