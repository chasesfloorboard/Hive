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
        paired(host, port, client.pair(host, port, code, deviceName, store.phoneKey))
    }

    private var autoConnecting = false
    /** Whether the paired Hive takes ratings from the phone (an older one doesn't: they're not "waiting"). */
    @Volatile private var pcTakesRatings = true

    /**
     * "Connect automatically": an unpaired phone looks for Hive on this
     * network and asks it to let the phone in; the PC asks its user once.
     * Paired phones already find their Hive again on every sync.
     */
    suspend fun autoConnect() {
        if (store.pairing != null || !store.autoConnect || autoConnecting) return
        autoConnecting = true
        try {
            // Only when exactly one Hive answers: with more (another computer, or something posing as Hive),
            // the phone lists them in Settings and the person picks, instead of taking whichever was first.
            val found = client.discover().distinctBy { it.serverId }
            if (found.size > 1) { _status.update { it.copy(connecting = null, error = "${found.size} Hives answered on this network. Pick yours in Settings › Hive on your PC.") }; return }
            val hive = found.firstOrNull() ?: return
            _status.update { it.copy(connecting = "Found ${hive.name}. Allow this phone in Hive on the PC…", error = null) }
            val ticket = client.requestConnect(hive.host, hive.port, deviceName, store.phoneKey)
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
        val fresh = Pairing(serverId = response.serverId, name = response.name, port = port, token = response.token, deviceId = response.deviceId, hosts = listOf(host))
        // Kept at once: the PC already counts this phone as paired, so an app closed during the checks below
        // must not forget it. Nothing is sent with it until connection() has checked the PC again.
        store.lastSeq = 0
        store.fullSyncDone = false
        store.pairing = fresh
        // At once onto the Hive's encrypted port when it has one (its certificate proved with the new pairing),
        // and the read-only media key fetched now, so nothing after pairing carries the token unencrypted.
        // If the check can't finish now, the first sync does it.
        val info = runCatching { if (isOurs(host, port, fresh)) client.info(connectionTo(host, port, fresh)) else null }.getOrNull()
        info?.coverKey?.ifBlank { null }?.let { store.coverKey = it }
        if (info != null) store.pairing = fresh.copy(hosts = listOf(host) + info.addresses.sortedBy { it.tailscale }.map { it.address })
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
            var used: HiveLinkClient.Connection? = null
            try {
                val conn = connection() ?: throw HiveLinkException("Can't reach ${store.pairing?.name ?: "Hive"}. Is it open on the PC?")
                used = conn
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
                // The PC answered on its plain port but not on its encrypted one: most likely a firewall.
                val blocked = used?.let { it.tlsPort > 0 && (e is java.net.ConnectException || e is java.net.SocketTimeoutException) } == true
                val message = if (blocked) "Hive on the PC answers, but not on its secure port ${used?.tlsPort}. If the PC has a firewall, allow TCP ${used?.tlsPort} on your home network."
                    else e.message ?: e.javaClass.simpleName
                _status.update { it.copy(error = message) }
            } finally {
                // Everything still waiting to go: favorites, ratings and plays (the status never says
                // "synced" over changes that haven't reached the PC).
                val waiting = (dao.pendingLove().size - stagedLove).coerceAtLeast(0) +
                    runCatching { (if (pcTakesRatings) dao.ratingsToSend().size else 0) + dao.unsentMatchedPlayCount() }.getOrDefault(0)
                _status.update { it.copy(syncing = false, pendingChanges = waiting) }
            }
        }
    }

    /**
     * Only the plays, both ways, for Yearly Wrap: much quicker than a whole sync. False when Hive
     * can't be reached. Waits for a sync already running (it sends them too).
     */
    suspend fun syncPlaysNow(): Boolean {
        if (store.pairing == null) return false
        return mutex.withLock {
            val conn = connection() ?: return@withLock false
            runCatchingNotCancelled { syncPlays(conn) }.isSuccess
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
            TrackMatcher.Candidate(it.id, it.title, it.artist, it.albumArtist, it.duration, it.album)
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
            (pc?.id ?: index.match(t.title, t.artist, t.albumArtist, t.durationMs, t.album)?.key)?.let { PcMatch(t.id, it) }
        }
        step("match ${phone.size} phone tracks -> ${matches.size}")
        dao.replaceMatches(matches)
        // Each song's play count as Hive has it, so both show the same number.
        for (m in matches) pcById[m.pcId]?.let { dao.setPcPlays(m.trackId, it.playCount.toInt()) }
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
                pcLoved && mine?.loved != true -> LoveState(m.trackId, true, mine?.changedAt ?: System.currentTimeMillis(), pending = false)
                !pcLoved && mine?.loved == true -> mine.copy(pending = true)
                else -> null
            }
        }
        // Written only where nothing was tapped meanwhile (see settleLove).
        dao.settleLove(adopt.mapNotNull { a -> local[a.trackId]?.let { a.trackId to it.changedAt } }.toMap(), adopt)
        // Ratings: the newer one wins, on either side.
        val mine = dao.allRatings().associateBy { it.trackId }
        adoptRatings(matches.mapNotNull { m -> pcById[m.pcId]?.let { Triple(m.trackId, it.rating.toFloat(), it.ratedAt) } }, mine)
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
        // The covers-only key (see hive-link.js coverKeyFor): cover links carry it instead of the token.
        if (store.coverKey != info.coverKey.ifBlank { null }) store.coverKey = info.coverKey.ifBlank { null }
        _status.update { it.copy(waitingOnPc = info.inbox.loves + info.inbox.plays) }
        rememberAddresses(info)
        if (!info.plays) return
        pushPlays(conn)
        // Hive learns this phone's key once per pairing, so a reinstall comes back without asking.
        val pairedAs = store.pairing?.deviceId
        if (info.phoneKeys && pairedAs != null && store.keyGivenFor != pairedAs) runCatchingNotCancelled { client.sendPhoneKey(conn, store.phoneKey); store.keyGivenFor = pairedAs }
        pcTakesRatings = info.ratings
        if (info.ratings) runCatchingNotCancelled { pushRatings(conn) }.onFailure { android.util.Log.w("HiveSync", "ratings: ${it.message}") }
        // Hive shares plays it didn't before (this phone's own, imported MusicBee history): all of them
        // again from the start; any already here is skipped below.
        if (info.playsVersion > store.pcPlaysVersion) { store.lastPcPlayAt = 0; store.pcPlaysVersion = info.playsVersion }
        val trackFor = dao.allMatches().groupBy({ it.pcId }, { it.trackId })
        // Hive sends at most 5000 at a time, oldest first: ask again from the newest until it has no more.
        while (true) {
            val fetched = client.plays(conn, store.lastPcPlayAt)
            val fresh = fetched.flatMap { p -> trackFor[p.id].orEmpty().take(1).map { Play(trackId = it, playedAt = p.playedAt, listenedMs = p.listenedMs, synced = true, fromPc = true) } }
                // Plays made on this phone come back from the PC too (a fresh install gets its listening back);
                // one already here, at the same moment, isn't added twice.
                .filter { dao.playsAtTime(it.playedAt) == 0 }
            if (fresh.isNotEmpty()) dao.insertPlays(fresh)
            val newest = fetched.maxOfOrNull { it.playedAt } ?: break
            if (newest <= store.lastPcPlayAt) break
            store.lastPcPlayAt = newest
            if (fetched.size < 5000) break
        }
        // With this phone's plays now in it, Hive's listening history file comes here as a
        // byte-for-byte copy, so phone and PC keep the same readable history.
        if (info.listening) runCatchingNotCancelled {
            client.listening(conn, store.listeningVersion)?.let { (version, bytes) -> saveListening(bytes); store.listeningVersion = version }
        }.onFailure { android.util.Log.w("HiveSync", "listening history not saved", it) }
        // After this phone's plays and ratings went: Hive's numbers, which now include them.
        if (info.trackStats) runCatchingNotCancelled { pullTrackStats(conn) }.onFailure { android.util.Log.w("HiveSync", "ratings and play counts: ${it.message}") }
        _status.update { it.copy(waitingOnPc = info.inbox.loves + info.inbox.plays) }
    }

    private suspend fun pushPlays(conn: HiveLinkClient.Connection) {
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
    }

    /**
     * Ratings made here go to Hive on the PC. A song Hive has, rated there as here, or not in Hive at
     * all is settled; one waiting for the user to trust this phone, or that failed, goes again next time.
     */
    /**
     * Hive's ratings ([trackId], stars, when set) taken where they're newer than the phone's: a
     * rating changed on the phone and not yet sent stays (it goes to Hive, which keeps the newer).
     * 0 stars from Hive takes the phone's rating off when Hive recorded taking it off.
     */
    private suspend fun adoptRatings(pc: List<Triple<Long, Float, Long>>, mine: Map<Long, Rating>) {
        val now = System.currentTimeMillis()
        val changes = pc.mapNotNull { (trackId, stars, ratedAt) ->
            val current = mine[trackId]
            when {
                current?.pending == true && (ratedAt <= 0 || current.changedAt >= ratedAt) -> null
                // Only a rating Hive itself took off (it knows when): 0 can also be a rating Hive hasn't read from the file yet.
                stars <= 0f -> current?.takeIf { it.stars > 0f && ratedAt > 0 }?.let { Rating(trackId, 0f, ratedAt, fromPc = true) }
                current == null || current.stars != stars || current.pending -> Rating(trackId, stars, ratedAt.takeIf { it > 0 } ?: now, fromPc = true)
                else -> null
            }
        }
        if (changes.isEmpty()) return
        dao.upsertRatings(changes)
        dao.forgetClearedRatings()
    }

    /** Ratings and play counts changed in Hive since the last look: the phone shows the same. */
    private suspend fun pullTrackStats(conn: HiveLinkClient.Connection) {
        val stats = client.trackStats(conn, store.trackStatsSince)
        if (stats.tracks.isNotEmpty()) {
            val tracksFor = dao.allMatches().groupBy({ it.pcId }, { it.trackId })
            val mine = dao.allRatings().associateBy { it.trackId }
            val ratings = ArrayList<Triple<Long, Float, Long>>()
            for (s in stats.tracks) for (trackId in tracksFor[s.id].orEmpty()) {
                dao.setPcPlays(trackId, s.playCount)
                ratings += Triple(trackId, s.rating.toFloat(), s.ratedAt)
            }
            adoptRatings(ratings, mine)
        }
        if (stats.now > 0) store.trackStatsSince = stats.now
    }

    private suspend fun pushRatings(conn: HiveLinkClient.Connection) {
        val pending = dao.ratingsToSend()
        if (pending.isEmpty()) return
        for (chunk in pending.chunked(500)) {
            val answer = client.sendRatings(conn, chunk.map { com.local.hive.mobile.link.RatingOut(it.pcId, it.stars, it.changedAt) })
            // "stale": Hive has a newer rating, which comes here with the next look at its numbers.
            for (r in chunk) if (answer[r.pcId] in setOf("applied", "unchanged", "not-found", "stale")) dao.ratingSent(r.trackId, r.changedAt)
            if (chunk.any { answer[it.pcId] == "stale" }) store.trackStatsSince = 0
        }
        dao.forgetClearedRatings()
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
        dao.settleLove(phoneOnly.associate { it.trackId to it.changedAt }, phoneOnly.map { it.copy(pending = false) })

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
            dao.settleLove(chunk.associate { it.trackId to it.changedAt }, resolved)
        }
    }

    private suspend fun applyRemote(events: List<LoveEvent>) {
        if (events.isEmpty()) return
        val deviceId = store.pairing?.deviceId
        val tracksFor = dao.allMatches().groupBy({ it.pcId }, { it.trackId })
        val updates = mutableListOf<LoveState>()
        val seen = HashMap<Long, Long>()
        for (event in events) {
            if (event.origin == deviceId) continue // our own change coming back
            for (trackId in tracksFor[event.id].orEmpty()) {
                val mine = dao.love(trackId)
                if (mine != null) seen.putIfAbsent(trackId, mine.changedAt)
                if (mine != null && mine.pending && mine.changedAt > event.at) continue
                // Already so here: the song keeps the date it was favorited (a file write on the PC
                // that left Love as it was is not a new favorite).
                if (mine != null && !mine.pending && mine.loved == event.loved) continue
                updates += LoveState(trackId, event.loved, event.at, pending = false)
            }
        }
        dao.settleLove(seen, updates)
    }

    /**
     * Addresses the PC has gained since pairing (Tailscale, a new network) are kept to try when the
     * usual one doesn't answer: that is how the phone reaches Hive away from home.
     */
    private fun rememberAddresses(info: InfoResponse) {
        val p = store.pairing ?: return
        val more = info.addresses.map { it.address }.filter { it !in p.hosts }
        if (more.isNotEmpty()) store.pairing = p.copy(hosts = p.hosts + more)
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
                    val info = runCatchingNotCancelled { client.info(conn) }.getOrNull()
                    info?.let { rememberAddresses(it) }
                    val caps = info?.streams
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

    /**
     * Whether [host] is really the paired Hive (see HiveLinkClient.hello). A Hive from before the check
     * passes on its id alone, until the paired Hive has once proved itself: then never again.
     */
    private suspend fun isOurs(host: String, port: Int, pairing: Pairing): Boolean {
        val hello = client.hello(host, port, pairing)
        return when (hello.kind) {
        HiveLinkClient.Hello.PROVED -> {
            if (store.helloSeenFor != pairing.serverId) store.helloSeenFor = pairing.serverId
            val knownTls = store.tlsFor == pairing.serverId && store.tlsPin != null
            when {
                // Its certificate, proved with the pairing: pinned, and the token goes only over the encrypted port.
                hello.tlsPin != null -> {
                    if (store.tlsPin != hello.tlsPin || store.tlsPort != hello.tlsPort || store.tlsFor != pairing.serverId) {
                        store.tlsPin = hello.tlsPin; store.tlsPort = hello.tlsPort; store.tlsFor = pairing.serverId
                    }
                    HiveLinkClient.pinnedCerts = setOf(hello.tlsPin)
                    true
                }
                // This Hive used to offer encryption and now doesn't: someone in between may have stripped it.
                // The token isn't sent unencrypted to it.
                knownTls -> {
                    _status.update { it.copy(error = "Hive on the PC isn't offering its secure connection right now, so this phone won't send its key. Restart Hive on the PC (or update it).") }
                    false
                }
                else -> true
            }
        }
        HiveLinkClient.Hello.OLD_HIVE -> store.helloSeenFor != pairing.serverId && client.serverAt(host, port) == pairing.serverId
        HiveLinkClient.Hello.NOT_IT -> false
        // Unpaired on the PC: said here at once (no token sent: it's of no use there), so the person can pair
        // again. Something posing as the Hive can at worst make the phone ask to be paired again.
        // The PC says it no longer knows this phone. That answer can't be signed (the PC has no pairing left
        // to sign with), so the phone's pairing is kept: anything posing as the PC could send it. The person
        // is told, and pairs again (or the PC finds it again) when they choose.
        HiveLinkClient.Hello.UNPAIRED -> {
            _status.update { it.copy(error = "Hive on the PC says this phone isn't paired with it any more. Pair it again in Settings › Hive on your PC.") }
            false
        }
        }
    }

    /** The connection to [host]: on the Hive's encrypted port when it has proved one (see isOurs). */
    private fun connectionTo(host: String, port: Int, pairing: Pairing): HiveLinkClient.Connection {
        val tlsPort = if (store.tlsFor == pairing.serverId && store.tlsPin != null) store.tlsPort else 0
        store.tlsPin?.takeIf { tlsPort > 0 }?.let { HiveLinkClient.pinnedCerts = setOf(it) }
        return HiveLinkClient.Connection(host, port, pairing.token, tlsPort)
    }

    private suspend fun connection(): HiveLinkClient.Connection? {
        val pairing = store.pairing ?: return null
        // The cable first: Hive on the PC answers on this phone's own address while it's plugged in.
        // But only commit to it if the encrypted port is reachable there too — a leftover `adb reverse`
        // of the main port alone (common after a cable session) otherwise traps every secure call on
        // 127.0.0.1:<tlsPort>, which has no tunnel, so sync fails while the PC is plainly reachable.
        if (client.serverAt(HiveLinkClient.USB_HOST, pairing.port) == pairing.serverId && isOurs(HiveLinkClient.USB_HOST, pairing.port, pairing)) {
            val tlsPort = if (store.tlsFor == pairing.serverId && store.tlsPin != null) store.tlsPort else 0
            if (tlsPort <= 0 || client.reachable(HiveLinkClient.USB_HOST, tlsPort)) {
                activeHost = HiveLinkClient.USB_HOST
                if (HiveLinkClient.USB_HOST !in pairing.hosts) store.pairing = pairing.copy(hosts = pairing.hosts + HiveLinkClient.USB_HOST)
                return connectionTo(HiveLinkClient.USB_HOST, pairing.port, pairing)
            }
        }
        if (store.pairing == null) return null
        val candidates = (listOfNotNull(activeHost) + pairing.hosts).filter { it != HiveLinkClient.USB_HOST }
        for (host in candidates.distinct()) {
            // Only the paired Hive: a host answering at a remembered address (the router may have given
            // it to another device since) gets nothing, not even the token.
            if (isOurs(host, pairing.port, pairing)) {
                activeHost = host
                if (pairing.hosts.firstOrNull() != host) store.pairing = pairing.copy(hosts = listOf(host) + pairing.hosts)
                return connectionTo(host, pairing.port, pairing)
            }
        }
        val found = client.discover().filter { it.serverId == pairing.serverId }.firstOrNull { isOurs(it.host, it.port, pairing) } ?: return null
        activeHost = found.host
        store.pairing = pairing.copy(port = found.port, hosts = listOf(found.host) + pairing.hosts)
        return connectionTo(found.host, found.port, pairing)
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
