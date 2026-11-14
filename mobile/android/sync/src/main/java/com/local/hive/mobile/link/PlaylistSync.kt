package com.local.hive.mobile.link

import com.local.hive.mobile.data.writeTextAtomic

import android.content.Context
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.Playlist
import com.local.hive.mobile.data.PlaylistEntry
import com.local.hive.mobile.data.StreamTrack
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File

/**
 * The phone's playlists and Hive's are one set. Each phone playlist is linked to one of Hive's;
 * a playlist made, changed, renamed or deleted on either side is made so on the other at the next
 * sync, and when both changed since they last agreed, the newer change wins. Songs go by Hive's
 * song ids (the phone's copies where it has them), streamed songs as they are. A phone song Hive
 * doesn't have yet stays in the phone's playlist.
 */
class PlaylistSync(context: Context, private val dao: LibraryDao, private val client: HiveLinkClient, private val pcLibrary: PcLibrary) {
    /** A phone playlist and Hive's, and each side's change time when they last agreed. */
    @Serializable data class Link(val phoneId: Long, val pcId: String, val phoneAt: Long, val pcAt: Long, val pcSongs: String = "")

    /** What a playlist of Hive's holds, to notice a change Hive made without a new time (a fix in how it's read). */
    private fun songsOf(name: String, songs: List<PcPlaylistSong>) = (name + "|" + songs.joinToString(",") { it.kind + ":" + it.id + it.key }).hashCode().toString()

    private val file = File(context.filesDir, "playlist-links.json")
    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()
    private val prefs = context.getSharedPreferences("playlist-sync", Context.MODE_PRIVATE)
    private val _active = MutableStateFlow(prefs.getBoolean("active", false))
    /** True once Hive on the PC keeps playlists in step with the phone: there is then one list of playlists. */
    val active: StateFlow<Boolean> = _active.asStateFlow()

    private fun load(): MutableList<Link> = runCatching { json.decodeFromString(ListSerializer(Link.serializer()), file.readText()).toMutableList() }.getOrDefault(mutableListOf())
    private fun save(links: List<Link>) { runCatching { file.writeTextAtomic(json.encodeToString(ListSerializer(Link.serializer()), links)) } }

    /** Brings the two sets of playlists into step; [log] says what changed. */
    suspend fun run(conn: HiveLinkClient.Connection, log: (String) -> Unit = {}) = lock.withLock {
        val info = client.info(conn)
        if (!info.playlistSync) return@withLock
        if (!_active.value) { prefs.edit().putBoolean("active", true).apply(); _active.value = true }
        val pcLists = client.playlists(conn)
        val pcById = pcLists.associateBy { it.id }
        val phone = dao.allPlaylistsOnce().associateBy { it.id }
        val matches = dao.allMatches()
        val trackForPc = HashMap<String, Long>().apply { matches.forEach { putIfAbsent(it.pcId, it.trackId) } }
        val pcForTrack = matches.associate { it.trackId to it.pcId }
        // Before the phone's songs are matched to Hive's (a new pairing), a playlist sent now would
        // reach Hive without its songs.
        if (matches.isEmpty()) return@withLock
        // Hive's song list, so a song the phone has no copy of is still known by its name.
        runCatching { pcLibrary.refresh() }
        val pcTracks = pcLibrary.tracks.value.associateBy { it.id }
        // Links are with one Hive. Another one (Hive reinstalled, a new PC) starts afresh: nothing on the
        // phone is deleted because that Hive lacks it; the phone's playlists go to it instead.
        val knownServer = prefs.getString("server", null)
        // (Links made before the Hive was noted down are its: kept.)
        val links = if (knownServer == null || knownServer == info.serverId) load() else mutableListOf<Link>().also {
            log("playlists: a different Hive on the PC; the phone's playlists go to it")
        }
        if (knownServer != info.serverId) prefs.edit().putString("server", info.serverId).apply()
        // Linked playlists all (or mostly) missing from Hive at once is Hive's list read wrong or
        // lost, not the user deleting them: the phone's are sent back rather than deleted.
        val goneOnPc = links.count { phone[it.phoneId] != null && pcById[it.pcId] == null }
        val bulkGone = goneOnPc > 0 && (pcLists.isEmpty() || (goneOnPc > 3 && goneOnPc * 2 > links.size))
        // Playlists taken before pictures came along get theirs now.
        for (l in links) {
            val p = phone[l.phoneId] ?: continue
            val pc = pcById[l.pcId] ?: continue
            val picture = pc.artworkUrl.ifBlank { null } ?: pcLibrary.coverFor(pc.cover) ?: continue
            if (p.imageUrl.isBlank()) dao.setPlaylistImage(p.id, picture, p.updatedAt)
        }
        val kept = mutableListOf<Link>()
        var made = 0; var sent = 0; var deleted = 0

        suspend fun push(p: Playlist, pcId: String): Link {
            val entries = dao.entriesOnce(p.id)
            val streams = dao.streamTracks(entries.mapNotNull { it.streamKey.ifBlank { null } }).associateBy { it.key }
            val songs = entries.mapNotNull { e ->
                when {
                    e.trackId != 0L -> pcForTrack[e.trackId]?.let { PcPlaylistSong(kind = "track", id = it) }
                    e.streamKey.startsWith("pc:") -> PcPlaylistSong(kind = "track", id = e.streamKey.removePrefix("pc:"))
                    else -> streams[e.streamKey]?.let { s -> PcPlaylistSong(kind = "stream", key = s.key, title = s.title, artist = s.artist, album = s.album, duration = s.durationMs) }
                }
            }
            val saved = client.savePlaylist(conn, PlaylistOut(pcId, p.name, p.updatedAt, songs))
            sent++
            return Link(p.id, saved.id, p.updatedAt, saved.updatedAt.toLong(), songsOf(p.name, songs))
        }

        /** Hive's playlist [pc] into the phone's [into] (or a new one); phone songs Hive lacks stay at the end. */
        suspend fun take(pc: PcPlaylist, into: Playlist?): Link {
            val at = pc.updatedAt.toLong().takeIf { it > 0 } ?: System.currentTimeMillis()
            val slots = mutableListOf<PlaylistEntry>()
            val streams = mutableListOf<StreamTrack>()
            for (s in pc.songs) {
                if (s.kind == "track") {
                    val mine = trackForPc[s.id]
                    if (mine != null) slots += PlaylistEntry(playlistId = 0, trackId = mine, position = 0)
                    else {
                        // Played through Hive; never left out, even when its details aren't known yet.
                        val t = pcTracks[s.id]
                        val st = if (t != null) StreamTrack("pc:${t.id}", "Hive", t.title, t.artist, t.album, t.duration, pcLibrary.coverUrl(t).orEmpty(), "", "")
                            else StreamTrack("pc:${s.id}", "Hive", "Song on your PC", "", "", 0, "", "", "")
                        streams += st; slots += PlaylistEntry(playlistId = 0, trackId = 0, position = 0, streamKey = st.key)
                    }
                } else {
                    val st = StreamTrack(s.key, if (s.key.startsWith("am:")) "Apple Music" else "Spotify", s.title, s.artist, s.album, s.duration, pcLibrary.coverFor(s.cover).orEmpty(), "", "")
                    streams += st; slots += PlaylistEntry(playlistId = 0, trackId = 0, position = 0, streamKey = st.key)
                }
            }
            // Its picture from where it came from (Apple Music's or Spotify's cover), the web copy first so it
            // shows away from home too; a photo chosen on the phone stays.
            val picture = pc.artworkUrl.ifBlank { null } ?: pcLibrary.coverFor(pc.cover)
            val id = if (into == null) {
                made++
                dao.createImportedPlaylist(Playlist(name = pc.name, createdAt = at, updatedAt = at, imageUrl = picture.orEmpty()), slots, streams)
            } else {
                if (picture != null && !into.imageUrl.startsWith("file:") && into.imageUrl != picture) dao.setPlaylistImage(into.id, picture, at)
                val onlyHere = dao.entriesOnce(into.id).filter { it.trackId != 0L && it.trackId !in pcForTrack }
                dao.upsertStreamTracks(streams)
                dao.setPlaylistEntries(into.id, slots + onlyHere, at)
                if (into.name != pc.name) dao.renamePlaylist(into.id, pc.name, at)
                into.id
            }
            return Link(id, pc.id, at, pc.updatedAt.toLong(), songsOf(pc.name, pc.songs))
        }

        val linkedPhone = HashSet<Long>()
        val linkedPc = HashSet<String>()
        for (l in links) {
            val p = phone[l.phoneId]
            val pc = pcById[l.pcId]
            val phoneChanged = p != null && p.updatedAt != l.phoneAt
            val pcChanged = pc != null && (pc.updatedAt.toLong() != l.pcAt || songsOf(pc.name, pc.songs) != l.pcSongs)
            when {
                // Deleted on the phone: deleted on the PC too, unless it changed there since.
                p == null && pc != null -> if (pcChanged) { kept += take(pc, null); linkedPc += pc.id } else { client.deletePlaylist(conn, pc.id); deleted++ }
                // Deleted on the PC: deleted here too, unless it changed here since.
                p != null && pc == null -> if (phoneChanged || bulkGone) { kept += push(p, ""); linkedPhone += p.id } else { dao.deletePlaylist(p.id); deleted++ }
                p == null || pc == null -> Unit
                else -> {
                    linkedPhone += p.id; linkedPc += pc.id
                    kept += when {
                        phoneChanged && (!pcChanged || p.updatedAt >= pc.updatedAt.toLong()) -> push(p, pc.id)
                        pcChanged -> take(pc, p)
                        else -> l
                    }
                }
            }
        }
        // New on either side. A phone playlist and one of Hive's with the same name are the same playlist
        // (a copy made before they were kept in step): the newer one wins.
        val unlinkedPhone = phone.values.filter { it.id !in linkedPhone && links.none { l -> l.phoneId == it.id } }.toMutableList()
        for (pc in pcLists.filter { it.id !in linkedPc && links.none { l -> l.pcId == it.id } }) {
            val twin = unlinkedPhone.firstOrNull { it.name.trim().equals(pc.name.trim(), ignoreCase = true) }
            if (twin != null) {
                unlinkedPhone -= twin
                kept += if (twin.updatedAt > pc.updatedAt.toLong()) push(twin, pc.id) else take(pc, twin)
            } else kept += take(pc, null)
        }
        for (p in unlinkedPhone) kept += push(p, "")
        save(kept)
        if (made + sent + deleted > 0) {
            runCatching { pcLibrary.refreshPlaylists() }
            log("playlists: $made from Hive, $sent sent to Hive, $deleted deleted")
        }
    }
}
