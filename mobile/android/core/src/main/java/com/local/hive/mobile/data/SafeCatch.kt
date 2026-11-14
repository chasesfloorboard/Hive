package com.local.hive.mobile.data

import kotlinx.coroutines.CancellationException

/**
 * Like [runCatching], but it NEVER swallows a coroutine [CancellationException] — that must propagate so a
 * cancelled/left composition or a cancelled scope actually stops. Use this at a module boundary that calls
 * network or other failable work so a routine failure (offline, timeout) degrades to a default instead of
 * throwing out of a `LaunchedEffect`/`launch` and crashing the process.
 *
 * Plain `runCatching { networkCall() }` is a bug in a coroutine: it catches CancellationException too.
 */
inline fun <T> runCatchingNotCancelled(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (c: CancellationException) {
        throw c
    } catch (t: Throwable) {
        Result.failure(t)
    }
