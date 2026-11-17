package com.local.hive.mobile.ui

import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.link.HiveLinkClient
import kotlinx.coroutines.flow.first

/**
 * The Yearly Wrap concern, lifted out of MainViewModel, which delegates wrap / wrapMonth / wrapYears here.
 * Paired: Hive's Wrap (kept on the phone) with this phone's not-yet-counted plays on top, refreshed from
 * the PC when it can be reached. Not paired: this phone's plays alone.
 */
class WrapVm(private val app: HiveApp) {
    private val dao = app.database.dao()
    private val linkClient = HiveLinkClient()
    private val pcLibrary get() = app.pcLibrary

    private val wrapCache get() = java.io.File(app.filesDir, "pc-wrap").apply { mkdirs() }

    private fun yearSpan(year: Int): Pair<Long, Long> {
        val zone = java.time.ZoneId.systemDefault()
        return java.time.LocalDate.of(year, 1, 1).atStartOfDay(zone).toInstant().toEpochMilli() to
            java.time.LocalDate.of(year + 1, 1, 1).atStartOfDay(zone).toInstant().toEpochMilli()
    }

    private suspend fun pcWrap(text: String): Wrap? = runCatching { linkClient.parseWrap(text) }.getOrNull()?.let { pc ->
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { Wrap.fromPc(pc, dao.albums().first()) { name -> pcLibrary.coverFor(name) } }
    }

    /**
     * A year's Wrap, at once and then up to date. Paired: Hive's Wrap as last fetched (kept on the
     * phone) with this phone's plays Hive hasn't counted yet added on top; then, when the PC can be
     * reached (at home or over Tailscale), only the new plays are sent and Hive's fresh Wrap, both
     * devices together, replaces it. Not paired: this phone's plays.
     */
    fun wrap(year: Int): kotlinx.coroutines.flow.Flow<Wrap> = kotlinx.coroutines.flow.flow {
        val (from, to) = yearSpan(year)
        suspend fun phoneOnly() = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { Wrap.from(year, dao.playsBetween(from, to)) }
        if (app.linkStore.pairing == null) { emit(phoneOnly()); return@flow }
        val cached = java.io.File(wrapCache, "$year.json")
        suspend fun withUnsent(w: Wrap) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { w + dao.unsentPlaysBetween(from, to) }
        val kept = cached.takeIf { it.exists() }?.let { runCatching { it.readText() }.getOrNull() }?.let { pcWrap(it) }
        emit(kept?.let { withUnsent(it) } ?: phoneOnly())
        if (!app.sync.syncPlaysNow()) return@flow
        val conn = app.sync.pcConnection() ?: return@flow
        val fresh = runCatching { linkClient.wrapJson(conn, year) }.getOrNull() ?: return@flow
        runCatching { cached.writeText(fresh) }
        pcWrap(fresh)?.let { emit(withUnsent(it)) }
    }

    /** One month of a Wrap, from the plays on this phone (the PC's among them, for songs the phone has). */
    suspend fun wrapMonth(year: Int, month: Int): Pair<Wrap, List<com.local.hive.mobile.data.PlayRow>> = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
        val zone = java.time.ZoneId.systemDefault()
        val start = java.time.LocalDate.of(year, month, 1).atStartOfDay(zone)
        val rows = dao.playsBetween(start.toInstant().toEpochMilli(), start.plusMonths(1).toInstant().toEpochMilli()).sortedBy { it.playedAt }
        Wrap.from(year, rows) to rows
    }

    /** Years with a Wrap, newest first: as last known at once, then Hive's when it can be reached. */
    fun wrapYears(): kotlinx.coroutines.flow.Flow<List<Int>> = kotlinx.coroutines.flow.flow {
        val first = dao.firstPlay()?.let { java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).year }
        val phone = (java.time.Year.now().value downTo (first ?: java.time.Year.now().value)).toList()
        if (app.linkStore.pairing == null) { emit(phone); return@flow }
        val cached = java.io.File(wrapCache, "years.txt")
        val kept = cached.takeIf { it.exists() }?.readText()?.split(',')?.mapNotNull { it.trim().toIntOrNull() }
        emit((kept.orEmpty() + phone).distinct().sortedDescending())
        val pc = app.sync.pcConnection()?.let { conn -> runCatching { linkClient.wrapYears(conn) }.getOrNull() } ?: return@flow
        runCatching { cached.writeText(pc.joinToString(",")) }
        emit((pc + phone).distinct().sortedDescending())
    }
}
