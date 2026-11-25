package com.local.hive.mobile.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext

/**
 * Pure reference counter for screens/overlays that permit landscape rotation.
 * Multiple nested surfaces (e.g. Now Playing opening CoverViewer) each acquire a lock;
 * portrait is only restored once every landscape-capable surface has closed.
 */
internal class LandscapeLockCounter {
    private var locks = 0

    val allowsLandscape: Boolean get() = locks > 0

    /** Acquires one landscape lock; returns true when transitioning from portrait -> landscape-allowed. */
    fun acquire(): Boolean {
        locks++
        return locks == 1
    }

    /** Releases one landscape lock; returns true when transitioning from landscape-allowed -> portrait. */
    fun release(): Boolean {
        if (locks <= 0) return false
        locks--
        return locks == 0
    }
}

private val activityLandscapeLocks = LandscapeLockCounter()

internal tailrec fun Context.findHostActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findHostActivity()
    else -> null
}

/**
 * Lets the user turn the phone sideways while [enabled] is true (e.g. in Now Playing,
 * the fullscreen Cover Viewer, or the Visualizer), and returns cleanly to portrait once
 * every landscape-capable surface closes.
 */
@Composable
fun AllowLandscape(enabled: Boolean = true) {
    val context = LocalContext.current
    DisposableEffect(context, enabled) {
        val activity = context.findHostActivity()
        if (enabled && activity != null) {
            if (activityLandscapeLocks.acquire()) {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
            }
            onDispose {
                if (activityLandscapeLocks.release()) {
                    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                }
            }
        } else {
            onDispose {}
        }
    }
}
