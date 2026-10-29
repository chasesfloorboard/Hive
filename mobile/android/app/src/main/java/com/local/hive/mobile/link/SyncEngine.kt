package com.local.hive.mobile.link

import android.os.Build
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.LoveState
import com.local.hive.mobile.data.Play
import com.local.hive.mobile.data.Rating
import com.local.hive.mobile.data.PcMatch
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
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
    /** Phone changes and plays waiting in Hive on the PC for the user to apply. */
    val waitingOnPc: Int = 0,
    val error: String? = null,
    /** While connecting automatically: what's happening ("Waiting for you to allow…"). */
    val connecting: String? = null,
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
    /** After each successful sync: song sync piggybacks on it (see SongSync). */
    private val afterSync: () -> Unit = {},
    /** Hive's themes (MusicBee skins and all), fetched once per launch. */
    private val onThemes: (ThemesResponse) -> Unit = {},
    /** Likes for streamed songs, shared with Hive too. */
    val streamLoves: StreamLoves? = null,
    /** Saves Hive's listening history file on the phone (see ListeningFile). */
    private val saveListening: (ByteArray) -> Unit = {},
) {
    private val mutex = Mutex()
    private val _streams = MutableStateFlow<PcStreams?>(null)
    /** Set while Hive on the PC is reachable: how the phone can stream through it. */
    val streams: StateFlow<PcStreams?> = _streams.asStateFlow()

    private val _status = MutableStateFlow(LinkStatus())
    val status: StateFlow<LinkStatus> = _status.asStateFlow()
    private var liveJob: Job? = null
    /** Pending Love changes Hive has received and holds in its inbox: sent, not yet settled. */
    private var stagedLove = 0
    private var activeHost: String? = null

    init {
        store.pairing?.let { p -> _status.update { it.copy(paired = true, serverName = p.name, lastSyncAt = store.lastSyncAt) } }
    }

    // ---- pairing ----

    private val deviceName get() = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).joinToString(" ")

    suspend fun pair(host: String, port: Int, code: String): Result<Unit> = runCatchingNotCancelled {
        paired(host, port, client.pair(host, port, code, deviceName))
    }

    private var autoConnecting = false

    /**
     * "Connect automatically": an unpaired phone looks for Hive on this
     * network and asks it to let the phone in; the PC asks its user once.
     * Paired phones already find their Hive again on every sync.
     */
    suspend fun autoConnect() {
        if (store.pairing != null || !store.autoConnect || autoConnecting) return
        autoConnecting = true
        try {
            val hive = client.discover().firstOrNull() ?: return
            _status.update { it.copy(connecting = "Found ${hive.name}. Allow this phone in Hive on the PC…", error = null) }
            val ticket = client.requestConnect(hive.host, hive.port, deviceName)
            repeat(70) {
                kotlinx.coroutines.delay(2_000)
                val answer = runCatching { client.connectAnswer(hive.host, hive.port, ticket) }.getOrNull() ?: return@repeat
                when (answer.status) {
                    "pending" -> Unit
                    "allowed" -> { paired(hive.host, hive.port, PairResponse(answer.token, answer.deviceId, answer.serverId, answer.name, answer.seq)); return }
                    else -> { _status.update { it.copy(connecting = null, error = answer.error ?: "Hive on the PC didn't allow this phone.") }; return }
                }
            }
            _status.update { it.copy(connecting = null, error = "Nobody answered in Hive on the PC.") }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A busy PC (already asking about another device) or no answer: try again next time Hive opens.
            _status.update { it.copy(connecting = null) }
        } finally {
            autoConnecting = false
            if (store.pairing != null) _status.update { it.copy(connecting = null) }
        }
    }

    private suspend fun paired(host: String, port: Int, response: PairResponse) {
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
        store.fullSyncDone = false
        activeHost = host
        _status.update { LinkStatus(paired = true, serverName = response.name, host = host) }
        // The first sync belongs to the engine, not to whoever asked to pair:
        // the pairing screen goes away the moment pairing succeeds.
        scope.launch { syncNow() }
        startLive()
    }

    suspend fun unpair() {
        stopLive()
        connection()?.let { client.unpair(it) }
        store.pairing = null
        dao.clearMatches()
        // Another PC is another library: what was "on both" no longer says anything.
        dao.clearSyncedSongs()
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
                // Changes come as Hive's change log, which keeps only the latest ones; a whole
                // comparison every few hours catches anything the log missed (bulk Love, imports).
                if (!store.fullSyncDone || System.currentTimeMillis() - store.lastFullSyncAt > FULL_SYNC_EVERY_MS) fullSync(conn) else pullChanges(conn)
                syncStreamLoves(conn) // may love phone files, sent next
                pushPending(conn)
                syncPlays(conn)
                store.lastSyncAt = System.currentTimeMillis()
                _status.update { it.copy(error = null, lastSyncAt = store.lastSyncAt, host = conn.host) }
                afterSync()
                // Each sync: the theme Hive shows may have changed since (Your Hive theme follows it).
                runCatching { client.themes(conn) }.onSuccess { onThemes(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: HiveLinkException) {
                if (e.status == 401) {
                    store.pairing = null
                    _status.value = LinkStatus(error = "This phone was unpaired from Hive. Pair it again.")
                } else _status.update { it.copy(error = e.message) }
            } catch (e: Exception) {
                _status.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
            } finally {
                _status.update { it.copy(syncing = false, pendingChanges = (dao.pendingLove().size - stagedLove).coerceAtLeast(0)) }
            }
        }
    }

    /** A heart on a streamed song: kept here, then sent to Hive. */
    fun setStreamLoved(title: String, artist: String, album: String, durationMs: Long, artworkUrl: String, mediaId: String, loved: Boolean) {
        val likes = streamLoves ?: return
        likes.set(title, artist, album, durationMs, artworkUrl, mediaId, loved)
        if (store.pairing != null) scope.launch { syncNow() } else scope.launch { applyStreamLovesToFiles() }
    }

    /** Streamed-song likes both ways (newest wins), then onto this phone's own copies. Older Hives don't share them. */
    private suspend fun syncStreamLoves(conn: HiveLinkClient.Connection) {
        val likes = streamLoves ?: return
        runCatchingNotCancelled { client.streamLoves(conn, likes.pendingChanges()) }.onSuccess { likes.mergeFromPc(it.loves) }
        applyStreamLovesToFiles()
    }

    /**
     * A liked streamed song this phone has (or later gets) as a file takes
     * the like, once per change, so unliking the file afterwards sticks. The
     * file's own Love then reaches the PC like any other.
     */
    private suspend fun applyStreamLovesToFiles() {
        val waiting = streamLoves?.waitingForFiles()?.takeIf { it.isNotEmpty() } ?: return
        val loved = dao.loveStates().first().associateBy { it.trackId }
        val now = System.currentTimeMillis()
        val changes = mutableListOf<LoveState>()
        val done = mutableMapOf<String, Long>()
        for (t in dao.allTracks()) {
            val k = StreamLoves.key(t.artist, t.title)
            val e = waiting[k] ?: continue
            done[k] = e.at
            if ((loved[t.id]?.loved == true) != e.loved) changes += LoveState(t.id, e.loved, now, pending = store.pairing != null)
        }
        if (changes.isNotEmpty()) dao.upsertLove(changes)
        streamLoves?.markApplied(done)
    }

    /** Like runCatching, but lets cancellation through instead of reporting it as a failure. */
    private inline fun <T> runCatchingNotCancelled(block: () -> T): Result<T> =
        try { Result.success(block()) } catch (e: CancellationException) { throw e } catch (e: Exception) { Result.failure(e) }

    /** The next sync re-matches everything: Hive's library gained songs (song sync sent some). */
    fun matchAgainNextSync() { store.fullSyncDone = false }

    /** Re-matches every phone track after a library rescan. */
    suspend fun rematch() {
        if (store.pairing == null) return
        store.fullSyncDone = false
        syncNow()
    }

    private suspend fun fullSync(conn: HiveLinkClient.Connection) {
        var t = System.currentTimeMillis()
        fun step(name: String) { val n = System.currentTimeMillis(); android.util.Log.i("HiveSync", "$name: ${n - t} ms"); t = n }
        val library = client.library(conn)
        step("download ${library.tracks.size} PC tracks")
        val index = TrackMatcher.Index(library.tracks.map {
            TrackMatcher.Candidate(it.id, it.title, it.artist, it.albumArtist, it.duration)
        })
        val pcById = library.tracks.associateBy { it.id }
        val phone = dao.allTracks()
        // As song sync pairs files: the same file to the byte (whatever either side reads from its
        // tags), then the same file name and length, then the tags.
        val bySize = library.tracks.filter { it.size > 0 }.groupBy { it.size }
        val byName = library.tracks.filter { it.file.isNotBlank() }.groupBy { it.file.lowercase() }
        fun close(a: Long, b: Long) = a <= 0 || b <= 0 || kotlin.math.abs(a - b) <= 2_000
        val matches = phone.mapNotNull { t ->
            val pc = bySize[t.sizeBytes]?.firstOrNull { close(it.duration, t.durationMs) }
                ?: byName[t.fileName.lowercase()]?.firstOrNull { it.duration > 0 && t.durationMs > 0 && close(it.duration, t.durationMs) }
            (pc?.id ?: index.match(t.title, t.artist, t.albumArtist, t.durationMs)?.key)?.let { PcMatch(t.id, it) }
        }
        step("match ${phone.size} phone tracks -> ${matches.size}")
        dao.replaceMatches(matches)
        step("save matches")

        // Favorites on either side become favorites on both: a song loved in Hive is loved here, and
        // one loved here goes to Hive (where a newer un-love made there wins, answered "stale").
        // Un-loving travels as a change, as it happens.
        val local = dao.allLove().associateBy { it.trackId }
        val adopt = matches.mapNotNull { m ->
            val pcLoved = pcById[m.pcId]?.loved ?: return@mapNotNull null
            val mine = local[m.trackId]
            when {
                mine?.pending == true -> null
                pcLoved && mine?.loved != true -> LoveState(m.trackId, true, mine?.changedAt ?: 0, pending = false)
                !pcLoved && mine?.loved == true -> mine.copy(pending = true)
                else -> null
            }
        }
        dao.upsertLove(adopt)
        // PC ratings come to the phone's copies; a rating made on the phone stays.
        val mine = dao.allRatings().associateBy { it.trackId }
        val now = System.currentTimeMillis()
        dao.upsertRatings(matches.mapNotNull { m ->
            val stars = (pcById[m.pcId]?.rating ?: 0.0).toFloat()
            val current = mine[m.trackId]
            if (stars <= 0f || (current != null && (!current.fromPc || current.stars == stars))) null else Rating(m.trackId, stars, now, fromPc = true)
        })
        step("favorites: ${adopt.count { !it.pending }} loved from Hive, ${adopt.count { it.pending }} to send to Hive, ${matches.size} of ${phone.size} songs matched")
        store.lastSeq = library.seq
        store.fullSyncDone = true
        store.lastFullSyncAt = System.currentTimeMillis()
        if (!store.droppedPlaysRequeued) {
            android.util.Log.i("HiveSync", "re-queued ${dao.unsendUnmatchedPlays()} plays of songs Hive didn't have")
            store.droppedPlaysRequeued = true
        }
        _status.update { it.copy(matchedTracks = matches.size, pcTracks = library.tracks.size) }
    }

    /**
     * Listening goes both ways: plays made here go to Hive on the PC (which
     * keeps them for the user to apply), and plays made in Hive come here,
     * so both count the same year. A Hive without plays support is skipped.
     */
    private suspend fun syncPlays(conn: HiveLinkClient.Connection) {
        val info = runCatchingNotCancelled { client.info(conn) }.getOrNull() ?: return
        _status.update { it.copy(waitingOnPc = info.inbox.loves + info.inbox.plays) }
        if (!info.plays) return
        // Hive counts them at once (or keeps them for review, older Hive). A play
        // Hive doesn't know the song of stays here and goes again later.
        while (true) {
            val batch = dao.playsToSend().takeIf { it.isNotEmpty() } ?: break
            var sent = 0
            for (chunk in batch.chunked(500)) {
                val answer = client.sendPlays(conn, chunk.map { PlayOut("${store.pairing?.deviceId}:${it.rowId}", it.pcId, it.playedAt, it.listenedMs) })
                val unknown = answer.unknown.toHashSet()
                val done = chunk.filter { "${store.pairing?.deviceId}:${it.rowId}" !in unknown }.map { it.rowId }
                dao.markPlaysSent(done)
                sent += done.size
            }
            if (sent == 0 || batch.size < 2000) break
        }
        val trackFor = dao.allMatches().groupBy({ it.pcId }, { it.trackId })
        val fetched = client.plays(conn, store.lastPcPlayAt)
        val fresh = fetched.flatMap { p -> trackFor[p.id].orEmpty().take(1).map { Play(trackId = it, playedAt = p.playedAt, listenedMs = p.listenedMs, synced = true, fromPc = true) } }
            .filter { dao.playCountAt(it.trackId, it.playedAt) == 0 }
        if (fresh.isNotEmpty()) dao.insertPlays(fresh)
        fetched.maxOfOrNull { it.playedAt }?.let { store.lastPcPlayAt = maxOf(store.lastPcPlayAt, it) }
        // With this phone's plays now in it, Hive's listening history file comes here as a
        // byte-for-byte copy, so phone and PC keep the same readable history.
        if (info.listening) runCatchingNotCancelled {
            client.listening(conn, store.listeningVersion)?.let { (version, bytes) -> saveListening(bytes); store.listeningVersion = version }
        }.onFailure { android.util.Log.w("HiveSync", "listening history not saved", it) }
        _status.update { it.copy(waitingOnPc = info.inbox.loves + info.inbox.plays) }
    }

    private suspend fun pullChanges(conn: HiveLinkClient.Connection) {
        val changes = client.loveChanges(conn, store.lastSeq)
        if (changes.reset) { fullSync(conn); return }
        applyRemote(changes.changes)
        store.lastSeq = maxOf(store.lastSeq, changes.seq)
    }

    private suspend fun pushPending(conn: HiveLinkClient.Connection) {
        val pending = dao.pendingLove()
        stagedLove = 0
        if (pending.isEmpty()) return
        val pcIdFor = dao.allMatches().associate { it.trackId to it.pcId }
        // A phone-only song has nothing to sync with; it stays Loved here.
        val (matched, phoneOnly) = pending.partition { pcIdFor[it.trackId] != null }
        dao.upsertLove(phoneOnly.map { it.copy(pending = false) })

        for (chunk in matched.chunked(200)) {
            val response = client.sendLove(conn, chunk.map { LoveChange(it.trackId, pcIdFor.getValue(it.trackId), it.loved, it.changedAt) })
            val byTrack = chunk.associateBy { it.trackId }
            stagedLove += response.results.count { it.status == "staged" }
            val resolved = response.results.mapNotNull { r ->
                val mine = byTrack[r.clientChangeId] ?: return@mapNotNull null
                when (r.status) {
                    // "staged": waiting in Hive's inbox for the user. It stays pending (and
                    // is resent) until Hive answers "unchanged" (applied) or "stale"
                    // (discarded); settling it early let the next full sync copy Hive's
                    // old state over it and undo the phone's change.
                    "staged" -> null
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
                    val caps = runCatchingNotCancelled { client.info(conn).streams }.getOrNull()
                    _streams.value = PcStreams(conn.host, conn.port, conn.token, songs = caps?.song == true)
                    runCatching {
                        client.events(conn, onStreamLoves = { scope.launch { syncNow() } }).collect { event ->
                            backoff = 2_000L
                            mutex.withLock {
                                applyRemote(listOf(event))
                                store.lastSeq = maxOf(store.lastSeq, event.seq)
                            }
                        }
                    }
                    _status.update { it.copy(live = false) }
                    _streams.value = null
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
        _streams.value = null
        _status.update { it.copy(live = false) }
    }

    /** The first reachable address of the paired Hive, rediscovering it if the PC's address changed. */
    /** A working connection to Hive on the PC, if it can be reached. */
    suspend fun pcConnection(): HiveLinkClient.Connection? = connection()

    private suspend fun connection(): HiveLinkClient.Connection? {
        val pairing = store.pairing ?: return null
        // The cable first: Hive on the PC answers on this phone's own address while it's plugged in.
        if (client.serverAt(HiveLinkClient.USB_HOST, pairing.port) == pairing.serverId) {
            activeHost = HiveLinkClient.USB_HOST
            if (HiveLinkClient.USB_HOST !in pairing.hosts) store.pairing = pairing.copy(hosts = pairing.hosts + HiveLinkClient.USB_HOST)
            return HiveLinkClient.Connection(HiveLinkClient.USB_HOST, pairing.port, pairing.token)
        }
        val candidates = (listOfNotNull(activeHost) + pairing.hosts).filter { it != HiveLinkClient.USB_HOST }
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

/**
 * Streaming through Hive on the PC: [songs] says whether it can find songs it
 * doesn't have on YouTube Music. The token goes only to this address.
 */
data class PcStreams(val host: String, val port: Int, val token: String, val songs: Boolean) {
    fun songUrl(s: com.local.hive.mobile.data.StreamTrack): String = android.net.Uri.Builder()
        .scheme("http").encodedAuthority("$host:$port").path("/api/stream/song")
        .appendQueryParameter("key", s.key).appendQueryParameter("title", s.title).appendQueryParameter("artist", s.artist)
        .appendQueryParameter("album", s.album).appendQueryParameter("duration", (s.durationMs / 1000).toString())
        .build().toString()

    fun isFor(uri: android.net.Uri) = uri.scheme == "http" && uri.host == host && uri.port == port
}

/** How often the phone compares every favorite with Hive's, beyond the change log. */
private const val FULL_SYNC_EVERY_MS = 3 * 60 * 60 * 1000L
