package com.local.hive.mobile.playback

/**
 * "Play next" in the order it was asked for: the first song picked plays next, the second after
 * it, and so on, then the queue carries on as it was (shuffled or not). [order] is the queue in
 * the order it plays (the shuffle order when shuffling), the songs just added anywhere in it.
 */
object UpNext {
    /** How many of [upNext] (the songs put to play next, still to come) follow [current] in [order] as they should. */
    fun run(order: List<Int>, current: Int, idAt: (Int) -> String, upNext: List<String>): Int {
        val from = order.indexOf(current)
        if (from < 0) return 0
        var n = 0
        while (n < upNext.size && from + 1 + n < order.size && idAt(order[from + 1 + n]) == upNext[n]) n++
        return n
    }

    /** [order] with [added] placed after [current] and the [run] songs already put to play next. */
    fun place(order: List<Int>, current: Int, added: List<Int>, run: Int): List<Int> {
        val rest = order.filter { it !in added }.toMutableList()
        val at = (rest.indexOf(current) + 1 + run).coerceIn(0, rest.size)
        rest.addAll(at, added)
        return rest
    }
}
