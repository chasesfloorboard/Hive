package com.local.hive.mobile.ui

import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track

/**
 * Songs and albums picked for a group action; long-press a song or an album
 * to start, tap to add or remove while picking. Holding one and dragging over
 * others picks every one between them, or, begun on one already picked,
 * un-picks them (see [albumDragSelect], [songDragSelect]).
 */
class Selection {
    val tracks = androidx.compose.runtime.mutableStateListOf<Track>()
    val albums = androidx.compose.runtime.mutableStateListOf<Long>()
    /** Apple Music and Spotify songs, picked on their pages and in the online search. */
    val streams = androidx.compose.runtime.mutableStateListOf<StreamTrack>()
    /**
     * Picked artists and playlists (and Favorites' album squares), by key, each with its songs: an
     * artist or a playlist picked anywhere plays, queues or goes to a playlist as all its songs.
     */
    class Group(val kind: String, val tracks: List<Track>)
    val groups = androidx.compose.runtime.mutableStateMapOf<String, Group>()
    fun hasGroup(key: String) = key in groups
    fun toggleGroup(key: String, kind: String, tracks: List<Track>) { if (groups.remove(key) == null) groups[key] = Group(kind, tracks) }
    val active: Boolean get() = tracks.isNotEmpty() || albums.isNotEmpty() || streams.isNotEmpty() || groups.isNotEmpty()
    // Ids beside the lists, so "is it picked" stays quick with thousands picked (Select all on Songs).
    // Reading the list's size first makes a check recompose when picks change.
    private val trackIds = HashSet<Long>()
    private val streamKeys = HashSet<String>()
    operator fun contains(t: Track) = tracks.size >= 0 && t.id in trackIds
    operator fun contains(s: StreamTrack) = streams.size >= 0 && s.key in streamKeys
    private fun add(t: Track) { if (trackIds.add(t.id)) tracks += t }
    private fun add(s: StreamTrack) { if (streamKeys.add(s.key)) streams += s }
    fun toggle(t: Track) { if (trackIds.remove(t.id)) tracks.removeAll { it.id == t.id } else add(t) }
    fun toggle(s: StreamTrack) { if (streamKeys.remove(s.key)) streams.removeAll { it.key == s.key } else add(s) }
    fun hasAlbum(id: Long) = id in albums
    fun toggleAlbum(id: Long) { if (!albums.remove(id)) albums += id }
    fun clear() { tracks.clear(); albums.clear(); streams.clear(); groups.clear(); trackIds.clear(); streamKeys.clear(); dragAnchor = null; trackDragAnchor = null }

    // ---- select all ----

    /** What a list on screen holds, for Select all (see [PickableList]). */
    class Scope(val tracks: List<Track> = emptyList(), val albums: List<Long> = emptyList(), val streams: List<StreamTrack> = emptyList())
    private val scopes = androidx.compose.runtime.mutableStateListOf<Scope>()
    fun register(scope: Scope) { scopes += scope }
    fun unregister(scope: Scope) { scopes.remove(scope) }

    /** The list being picked from: the one holding something picked (a pager keeps its neighbour pages composed too). */
    private val scope: Scope? get() = scopes.lastOrNull { sc -> val a = albums.toHashSet(); sc.tracks.any { it in this } || sc.albums.any { it in a } || sc.streams.any { it in this } } ?: scopes.lastOrNull()

    /** Everything in that list is picked. */
    val allPicked: Boolean get() = scope?.let { sc -> val a = albums.toHashSet(); sc.tracks.all { it in this } && sc.albums.all { it in a } && sc.streams.all { it in this } } ?: false

    /** Select all, or (all picked already) deselect all. */
    fun toggleAll() {
        val sc = scope ?: return
        if (allPicked) { clear(); return }
        // One list change each, not one per song.
        tracks.addAll(sc.tracks.filter { trackIds.add(it.id) })
        val albumSet = albums.toHashSet()
        albums.addAll(sc.albums.filter { albumSet.add(it) })
        streams.addAll(sc.streams.filter { streamKeys.add(it.key) })
    }

    /** The picked songs, then every song of the picked albums in album order. */
    fun picked(library: List<Track>): List<Track> {
        val fromGroups = groups.values.flatMap { it.tracks }
        if (albums.isEmpty()) return if (fromGroups.isEmpty()) tracks.toList() else (tracks + fromGroups).distinctBy { it.id }
        val byAlbum = library.filter { it.albumId in albums }.groupBy { it.albumId }
        val fromAlbums = albums.flatMap { id -> byAlbum[id].orEmpty().sortedWith(compareBy<Track> { it.discNumber }.thenBy { it.trackNumber }) }
        return (tracks + fromAlbums + fromGroups).distinctBy { it.id }
    }

    // ---- hold and drag over albums ----

    /** The album the finger went down on, while a hold-and-drag is picking. */
    var dragAnchor: Long? = null
        private set
    private var dragBase: List<Long> = emptyList()
    private var dragOver: Long? = null
    /** The albums of the grid on screen, in order, so a drag picks the ones between. */
    var albumOrder: List<Long> = emptyList()

    /** Whether the drag un-picks: it began on an album already picked. */
    private var dragRemoves = false

    fun startAlbumDrag(id: Long) {
        dragRemoves = id in albums
        dragBase = if (dragRemoves) albums.toList() else albums.filter { it != id }
        dragAnchor = id
        dragOver = null
        dragTo(id)
    }

    fun dragTo(id: Long) {
        val anchor = dragAnchor ?: return
        if (id == dragOver) return
        dragOver = id
        val from = albumOrder.indexOf(anchor)
        val to = albumOrder.indexOf(id)
        val range = if (from < 0 || to < 0) listOf(id) else albumOrder.subList(minOf(from, to), maxOf(from, to) + 1)
        val next = if (dragRemoves) dragBase - range.toSet() else (dragBase + range).distinct()
        albums.retainAll(next.toSet())
        next.forEach { if (it !in albums) albums += it }
    }

    fun endAlbumDrag() { dragAnchor = null; dragOver = null }

    // ---- hold and drag over songs (library songs and streamed ones alike) ----

    /** A song's id for a drag: a library song by its id, a streamed song by its key. */
    private fun dragId(x: Any): String = when (x) { is Track -> "t${x.id}"; is StreamTrack -> "s${x.key}"; else -> "" }
    private fun picked(x: Any) = when (x) { is Track -> x in this; is StreamTrack -> x in this; else -> false }

    /** The song the finger went down on, while a hold-and-drag is picking songs. */
    var trackDragAnchor: String? = null
        private set
    private var trackDragBase: List<Any> = emptyList()
    private var trackDragOver: String? = null
    /** The songs of the list on screen (Track or StreamTrack), in order, so a drag picks the ones between. */
    var trackOrder: List<Any> = emptyList()

    /** Whether the drag un-picks: it began on a song already picked. */
    private var trackDragRemoves = false

    fun startTrackDrag(song: Any) {
        val id = dragId(song)
        trackDragRemoves = picked(song)
        val all: List<Any> = tracks.toList() + streams.toList()
        trackDragBase = if (trackDragRemoves) all else all.filter { dragId(it) != id }
        trackDragAnchor = id
        trackDragOver = null
        dragToTrack(song)
    }

    fun dragToTrack(song: Any) {
        val anchor = trackDragAnchor ?: return
        val id = dragId(song)
        if (id == trackDragOver) return
        trackDragOver = id
        val from = trackOrder.indexOfFirst { dragId(it) == anchor }
        val to = trackOrder.indexOfFirst { dragId(it) == id }
        val range = if (from < 0 || to < 0) listOf(song) else trackOrder.subList(minOf(from, to), maxOf(from, to) + 1)
        val next = if (trackDragRemoves) range.mapTo(HashSet(), ::dragId).let { gone -> trackDragBase.filter { dragId(it) !in gone } }
            else (trackDragBase + range).distinctBy(::dragId)
        val keep = next.mapTo(HashSet(), ::dragId)
        tracks.removeAll { "t${it.id}" !in keep }
        trackIds.retainAll { "t$it" in keep }
        streams.removeAll { "s${it.key}" !in keep }
        streamKeys.retainAll { "s$it" in keep }
        next.forEach { when (it) { is Track -> add(it); is StreamTrack -> add(it) } }
    }

    fun endTrackDrag() { trackDragAnchor = null; trackDragOver = null }
}

val LocalSelection = androidx.compose.runtime.staticCompositionLocalOf<Selection?> { null }
