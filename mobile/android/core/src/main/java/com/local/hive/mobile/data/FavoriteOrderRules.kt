package com.local.hive.mobile.data

/**
 * Pure ordering rules for the Favorites / Home grid.
 *
 * Invariant: unliking any album, artist, playlist, or song forgets its prior manual position;
 * liking it again places it at the very top (newest-liked first) rather than snapping it back
 * to its old slot.
 */
object FavoriteOrderRules {
    /** Removes [keysToForget] from a saved custom order list. */
    fun forgetKeys(order: List<String>, vararg keysToForget: String): List<String> {
        if (order.isEmpty()) return order
        val drop = keysToForget.filter { it.isNotBlank() }.toSet()
        if (drop.isEmpty()) return order
        val next = order.filterNot { it in drop }
        return if (next.size == order.size) order else next
    }

    /**
     * Arranges [items] so newly-liked or re-liked items (those absent from [savedOrder])
     * appear at the very top ordered by [addedAtOf] descending, followed by manually arranged
     * items in their saved order.
     */
    fun <T> arrange(
        items: List<T>,
        savedOrder: List<String>,
        keyOf: (T) -> String,
        addedAtOf: (T) -> Long,
    ): List<T> {
        val at = savedOrder.withIndex().associate { it.value to it.index }
        val (known, fresh) = items.partition { keyOf(it) in at }
        return fresh.sortedByDescending(addedAtOf) + known.sortedBy { at[keyOf(it)] }
    }
}
