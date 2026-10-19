package com.local.hive.mobile.link

import android.os.Build
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.LoveState
import com.local.hive.mobile.data.PcMatch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class LinkStatus(
    val paired: Boolean = false,
    val serverName: String = "",
    val host: String = "",
    val live: Boolean = false,
    val syncing: Boolean = false,
    val lastSyncAt: Long = 0,
    val matchedTracks: Int = 0,
    val pcTracks: Int = 0,
    val pendingChanges: Int = 0,
    val error: String? = null,
)

/**
 * Keeps phone Love and Hive (PC) Love in step.
 *
 * Phone changes are stored at once as pending and pushed when the PC can be
 * reached; the PC applies them through its heart-button path and answers
 * "stale" when it holds a newer change, which the phone then adopts. PC
 * changes arrive live over server-sent events, or from the change log by
 * sequence number after time offline. A PC log that no longer reaches back
 * far enough triggers a full sync against the library listing.
 */
class SyncEngine(
    private val dao: LibraryDao,
    private val store: LinkStore,
    private val client: HiveLinkClient,
    private val scope: CoroutineScope,
) {
    private val mutex = Mutex()
    private val _status = MutableStateFlow(LinkStatus())
    val status: StateFlow<LinkStatus> = _status.asStateFlow()
    private var liveJob: Job? = null
    private var activeHost: String? = null

    init {
        store.pairing?.let { p -> _status.update { it.copy(paired = true, serverName = p.name, lastSyncAt = store.lastSyncAt) } }
    }

    // ---- pairing ----

    suspend fun pair(host: String, port: Int, code: String): Result<Unit> = runCatching {
        val deviceName = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).joinToString(" ")
        val response = client.pair(host, port, code, deviceName)
        val conn = HiveLinkClient.Connection(host, port, response.token)
        val info = runCatching { client.info(conn) }.getOrNull()
        store.pairing = Pairing(
            serverId = response.serverId,
            name = response.name,
            port = port,
            token = response.token,
            deviceId = response.deviceId,
            hosts = listOf(host) + info?.addresses.orEmpty().sortedBy { it.tailscale }.map { it.address },
        )
        store.lastSeq = 0
        activeHost = host
        _status.update { LinkStatus(paired = true, serverName = response.name, host = host) }
        syncNow()
        startLive()
    }

    suspend fun unpair() {
        stopLive()
        connection()?.let { client.unpair(it) }
        store.pairing = null
        dao.clearMatches()
        activeHost = null
        _status.value = LinkStatus()
    }

    // ---- local changes ----

    suspend fun setLoved(trackIds: Collection<Long>, loved: Boolean) {
        val now = System.currentTimeMillis()
        dao.upsertLove(trackIds.map { LoveState(it, loved, now, pending = store.pairing != null) })
        if (store.pairing != null) scope.launch { syncNow() }
    }

    // ---- sync ----

    suspend fun syncNow() {
        if (store.pairing == null) return
        mutex.withLock {
            _status.update { it.copy(syncing = true) }
            try {
                val conn = connection() ?: throw HiveLinkException("Can't reach ${store.pairing?.name ?: "Hive"}. Is it open on the PC?")
                pushPending(conn)
                if (store.lastSeq == 0L) fullSync(conn) else pullChanges(conn)
                store.lastSyncAt = System.currentTimeMillis()
                _status.update { it.copy(error = null, lastSyncAt = store.lastSyncAt, host = conn.host) }
            } catch (e: HiveLinkException) {
                if (e.status == 401) {
                    store.pairing = null
                    _status.value = LinkStatus(error = "This phone was unpaired from Hive. Pair it again.")
                } else _status.update { it.copy(error = e.message) }
            } catch (e: Exception) {
                _status.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
            } finally {
                _status.update { it.copy(syncing = false, pendingChanges = dao.pendingLove().size) }
            }
        }
    }

    /** Re-matches every phone track after a library rescan. */
    suspend fun rematch() {
        if (store.pairing == null) return
        store.lastSeq = 0
        syncNow()
    }

    private suspend fun fullSync(conn: HiveLinkClient.Connection) {
        val library = client.library(conn)
        val index = TrackMatcher.Index(library.tracks.map {
            TrackMatcher.Candidate(it.id, it.title, it.artist, it.albumArtist, it.duration)
        })
        val pcById = library.tracks.associateBy { it.id }
        val phone = dao.allTracks()
        val matches = phone.mapNotNull { t ->
            index.match(t.title, t.artist, t.albumArtist, t.durationMs)?.let { PcMatch(t.id, it.key) }
        }
        dao.replaceMatches(matches)

        val local = dao.allLove().associateBy { it.trackId }
        val adopt = matches.mapNotNull { m ->
            val pcLoved = pcById[m.pcId]?.loved ?: return@mapNotNull null
            val mine = local[m.trackId]
            if (mine?.pending == true || mine?.loved == pcLoved) null
            else LoveState(m.trackId, pcLoved, mine?.changedAt ?: 0, pending = false)
        }
        dao.upsertLove(adopt)
        store.lastSeq = library.seq
        _status.update { it.copy(matchedTracks = matches.size, pcTracks = library.tracks.size) }
    }

    private suspend fun pullChanges(conn: HiveLinkClient.Connection) {
        val changes = client.loveChanges(conn, store.lastSeq)
        if (changes.reset) { fullSync(conn); return }
        applyRemote(changes.changes)
        store.lastSeq = maxOf(store.lastSeq, changes.seq)
    }

    private suspend fun pushPending(conn: HiveLinkClient.Connection) {
        val pending = dao.pendingLove()
        if (pending.isEmpty()) return
        val pcIdFor = dao.allMatches().associate { it.trackId to it.pcId }
        // A phone-only song has nothing to sync with; it stays Loved here.
        val (matched, phoneOnly) = pending.partition { pcIdFor[it.trackId] != null }
        dao.upsertLove(phoneOnly.map { it.copy(pending = false) })

        for (chunk in matched.chunked(200)) {
            val response = client.sendLove(conn, chunk.map { LoveChange(it.trackId, pcIdFor.getValue(it.trackId), it.loved, it.changedAt) })
            val byTrack = chunk.associateBy { it.trackId }
            val resolved = response.results.mapNotNull { r ->
                val mine = byTrack[r.clientChangeId] ?: return@mapNotNull null
                when (r.status) {
                    "applied", "unchanged", "not-found" -> mine.copy(pending = false)
                    "stale" -> LoveState(mine.trackId, r.loved ?: mine.loved, r.at ?: mine.changedAt, pending = false)
                    else -> null // "failed": keep it pending and try again next sync
                }
            }
            dao.upsertLove(resolved)
        }
    }

    private suspend fun applyRemote(events: List<LoveEvent>) {
        if (events.isEmpty()) return
        val deviceId = store.pairing?.deviceId
        val tracksFor = dao.allMatches().groupBy({ it.pcId }, { it.trackId })
        val updates = mutableListOf<LoveState>()
        for (event in events) {
            if (event.origin == deviceId) continue // our own change coming back
            for (trackId in tracksFor[event.id].orEmpty()) {
                val mine = dao.love(trackId)
                if (mine != null && mine.pending && mine.changedAt > event.at) continue
                updates += LoveState(trackId, event.loved, event.at, pending = false)
            }
        }
        dao.upsertLove(updates)
    }

    // ---- live updates ----

    fun startLive() {
        if (liveJob?.isActive == true || store.pairing == null) return
        liveJob = scope.launch {
            var backoff = 2_000L
            while (isActive && store.pairing != null) {
                val conn = connection()
                if (conn != null) {
                    _status.update { it.copy(live = true, host = conn.host) }
                    runCatching {
                        client.events(conn).collect { event ->
                            backoff = 2_000L
                            mutex.withLock {
                                applyRemote(listOf(event))
                                store.lastSeq = maxOf(store.lastSeq, event.seq)
                            }
                        }
                    }
                    _status.update { it.copy(live = false) }
                    activeHost = null
                    syncNow() // catch up on anything missed while the stream was down
                }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(60_000L)
            }
        }
    }

    fun stopLive() {
        liveJob?.cancel()
        liveJob = null
        _status.update { it.copy(live = false) }
    }

    /** The first reachable address of the paired Hive, rediscovering it if the PC's address changed. */
    private suspend fun connection(): HiveLinkClient.Connection? {
        val pairing = store.pairing ?: return null
        val candidates = listOfNotNull(activeHost) + pairing.hosts
        for (host in candidates.distinct()) {
            if (client.ping(host, pairing.port)) {
                activeHost = host
                if (pairing.hosts.firstOrNull() != host) store.pairing = pairing.copy(hosts = listOf(host) + pairing.hosts)
                return HiveLinkClient.Connection(host, pairing.port, pairing.token)
            }
        }
        val found = client.discover().firstOrNull { it.serverId == pairing.serverId } ?: return null
        activeHost = found.host
        store.pairing = pairing.copy(port = found.port, hosts = listOf(found.host) + pairing.hosts)
        return HiveLinkClient.Connection(found.host, found.port, pairing.token)
    }
}
