package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import com.local.hive.mobile.ui.theme.Motion

/** The shared-element scope around the pages, and the page's own transition. */
val LocalSharedScope = compositionLocalOf<SharedTransitionScope?> { null }
val LocalPageScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

// The cover travels on One UI's open curve, the length of a page push; going
// back into the grid (shrinking), it takes the quicker back timing.
@OptIn(ExperimentalSharedTransitionApi::class)
private val CoverBounds = BoundsTransform { from, to ->
    if (to.width < from.width) tween(Motion.BACK_MS + 40, easing = Motion.Back) else tween(Motion.OPEN_MS, easing = Motion.Open)
}

/**
 * Marks a cover as the same object on two pages ("album-12"): opening an
 * album from the grid, the cover itself grows into the page header, and goes
 * back into the grid on the way out. Without the scopes it does nothing.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedCover(key: String): Modifier {
    val shared = LocalSharedScope.current ?: return this
    val page = LocalPageScope.current ?: return this
    return with(shared) {
        this@sharedCover.sharedElement(rememberSharedContentState(key), page, boundsTransform = CoverBounds)
    }
}
