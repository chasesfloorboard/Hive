package com.local.hive.mobile.ui

import kotlin.math.pow

/**
 * Pure edge auto-scroll & grid hit-test calculations for drag-to-reorder lists and grids.
 *
 * When a user long-presses and drags an album/artist/playlist tile (or queue/playlist row) near
 * the top or bottom of the viewport, [computeEdgeScrollDelta] yields a smooth, accelerating scroll
 * step so the user can move items all the way across long grids/lists instead of being trapped on
 * the currently visible screen.
 */
internal object DragAutoScroll {
    /**
     * Computes pixels to scroll on this frame (negative = scroll up / toward top,
     * positive = scroll down / toward bottom, 0f = finger is in the middle safe zone).
     */
    fun computeEdgeScrollDelta(
        pointerY: Float,
        viewportHeight: Float,
        edgeZonePx: Float,
        maxStepPx: Float,
        canScrollBackward: Boolean,
        canScrollForward: Boolean,
    ): Float {
        if (viewportHeight <= 0f || edgeZonePx <= 0f || maxStepPx <= 0f) return 0f
        val zone = minOf(edgeZonePx, viewportHeight * 0.35f)
        if (zone <= 0f) return 0f
        return when {
            pointerY < zone && canScrollBackward -> {
                val depth = ((zone - pointerY) / zone).coerceIn(0f, 1.5f)
                val eased = depth.coerceAtMost(1f).pow(1.4f) + (depth - 1f).coerceAtLeast(0f) * 0.5f
                -(eased * maxStepPx).coerceIn(2f, maxStepPx * 1.4f)
            }
            pointerY > viewportHeight - zone && canScrollForward -> {
                val depth = ((pointerY - (viewportHeight - zone)) / zone).coerceIn(0f, 1.5f)
                val eased = depth.coerceAtMost(1f).pow(1.4f) + (depth - 1f).coerceAtLeast(0f) * 0.5f
                (eased * maxStepPx).coerceIn(2f, maxStepPx * 1.4f)
            }
            else -> 0f
        }
    }

    internal data class VisibleSlot(
        val key: Any,
        val left: Float,
        val top: Float,
        val right: Float,
        val bottom: Float,
    )

    /**
     * Finds the swap target slot for a dragged item whose center is at ([centerX], [centerY]).
     * Direct hit wins; if the finger has been dragged above the first visible movable tile (e.g.
     * while edge-scrolling toward the top), targets the nearest movable tile on that edge so the
     * item keeps advancing all the way to position 0!
     */
    fun findSwapTargetKey(
        draggedKey: String,
        pinnedKey: String,
        centerX: Float,
        centerY: Float,
        visible: List<VisibleSlot>,
    ): String? {
        val movable = visible.filter { it.key is String && it.key != pinnedKey }
        if (movable.isEmpty()) return null
        val direct = movable.firstOrNull {
            it.key != draggedKey &&
                centerX >= it.left && centerX <= it.right &&
                centerY >= it.top && centerY <= it.bottom
        }
        if (direct != null) return direct.key as String

        // If dragged past the top or bottom of visible movable slots (e.g., while scrolling up/down),
        // snap to the closest horizontal slot on the topmost/bottommost visible row.
        val minTop = movable.minOf { it.top }
        if (centerY < minTop) {
            val topRow = movable.filter { it.top <= minTop + 4f && it.key != draggedKey }
            return topRow.minByOrNull { kotlin.math.abs((it.left + it.right) / 2f - centerX) }?.key as? String
        }
        val maxBottom = movable.maxOf { it.bottom }
        if (centerY > maxBottom) {
            val bottomRow = movable.filter { it.bottom >= maxBottom - 4f && it.key != draggedKey }
            return bottomRow.minByOrNull { kotlin.math.abs((it.left + it.right) / 2f - centerX) }?.key as? String
        }
        return null
    }
}
