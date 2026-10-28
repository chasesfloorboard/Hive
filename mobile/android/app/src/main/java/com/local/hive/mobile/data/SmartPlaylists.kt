package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** One rule of a smart playlist: [field] [op] [value], e.g. genre contains "house". */
@Serializable
data class SmartRule(val field: SmartField, val op: SmartOp, val value: String = "")

@Serializable
enum class SmartField(val label: String, val kind: Kind) {
    Title("Title", Kind.Text), Artist("Artist", Kind.Text), AlbumArtist("Album artist", Kind.Text), Album("Album", Kind.Text),
    Genre("Genre", Kind.Text), Folder("Folder", Kind.Text), Year("Year", Kind.Number), Rating("Rating", Kind.Number),
    Plays("Plays", Kind.Number), LengthMinutes("Length (minutes)", Kind.Number), AddedDays("Added", Kind.Days),
    Favorite("Favorite", Kind.Flag), Lossless("Lossless", Kind.Flag);

    enum class Kind { Text, Number, Days, Flag }
    val ops: List<SmartOp> get() = when (kind) {
        Kind.Text -> listOf(SmartOp.Contains, SmartOp.Is, SmartOp.IsNot, SmartOp.StartsWith, SmartOp.DoesNotContain)
        Kind.Number -> listOf(SmartOp.Is, SmartOp.AtLeast, SmartOp.AtMost)
        Kind.Days -> listOf(SmartOp.InLast, SmartOp.NotInLast)
        Kind.Flag -> listOf(SmartOp.Yes, SmartOp.No)
    }
}

@Serializable
enum class SmartOp(val label: String) {
    Contains("contains"), Is("is"), IsNot("is not"), StartsWith("starts with"), DoesNotContain("doesn't contain"),
    AtLeast("is at least"), AtMost("is at most"), InLast("in the last (days)"), NotInLast("not in the last (days)"),
    Yes("yes"), No("no"),
}

@Serializable
enum class SmartSort(val label: String) { Title("Title"), Artist("Artist"), Album("Album"), Newest("Newest first"), RecentlyAdded("Recently added"), MostPlayed("Most played"), TopRated("Top rated"), Random("Shuffled") }

/** A playlist that fills itself from the library by its rules, as Hive's smart playlists do. */
@Serializable
data class SmartPlaylist(
    val id: Long,
    val name: String,
    val rules: List<SmartRule>,
    val matchAll: Boolean = true,
    val sort: SmartSort = SmartSort.Artist,
    /** At most this many songs; 0 for all. */
    val limit: Int = 0,
) {
    /** What it holds now. [plays] and [ratings] by track id; [now] for the "Added" rules. */
    fun select(tracks: List<Track>, plays: Map<Long, Int>, ratings: Map<Long, Float>, loved: Set<Long>, now: Long = System.currentTimeMillis()): List<Track> {
        fun test(t: Track, r: SmartRule): Boolean {
            val v = r.value.trim()
            fun text(s: String) = when (r.op) {
                SmartOp.Contains -> s.contains(v, ignoreCase = true)
                SmartOp.Is -> s.equals(v, ignoreCase = true)
                SmartOp.IsNot -> !s.equals(v, ignoreCase = true)
                SmartOp.StartsWith -> s.startsWith(v, ignoreCase = true)
                SmartOp.DoesNotContain -> !s.contains(v, ignoreCase = true)
                else -> false
            }
            fun number(n: Double): Boolean {
                val want = v.toDoubleOrNull() ?: return false
                return when (r.op) { SmartOp.Is -> n == want; SmartOp.AtLeast -> n >= want; SmartOp.AtMost -> n <= want; else -> false }
            }
            fun flag(b: Boolean) = if (r.op == SmartOp.Yes) b else !b
            return when (r.field) {
                SmartField.Title -> text(t.title)
                SmartField.Artist -> text(t.artist)
                SmartField.AlbumArtist -> text(t.displayAlbumArtist)
                SmartField.Album -> text(t.album)
                SmartField.Genre -> text(t.genre)
                SmartField.Folder -> text(t.folder)
                SmartField.Year -> t.year > 0 && number(t.year.toDouble())
                SmartField.Rating -> number((ratings[t.id] ?: 0f).toDouble())
                SmartField.Plays -> number((plays[t.id] ?: 0).toDouble())
                SmartField.LengthMinutes -> number(t.durationMs / 60_000.0)
                SmartField.AddedDays -> {
                    val days = v.toLongOrNull() ?: return false
                    val within = t.dateAdded >= now - days * 86_400_000L
                    if (r.op == SmartOp.InLast) within else !within
                }
                SmartField.Favorite -> flag(t.id in loved)
                SmartField.Lossless -> flag(t.fileName.substringAfterLast('.', "").lowercase() in LOSSLESS)
            }
        }
        val picked = tracks.filter { t -> if (rules.isEmpty()) true else if (matchAll) rules.all { test(t, it) } else rules.any { test(t, it) } }
        val sorted = when (sort) {
            SmartSort.Title -> picked.sortedBy { it.title.lowercase() }
            SmartSort.Artist -> picked.sortedWith(compareBy({ it.displayAlbumArtist.lowercase() }, { it.album.lowercase() }, { it.discNumber }, { it.trackNumber }))
            SmartSort.Album -> picked.sortedWith(compareBy({ it.album.lowercase() }, { it.discNumber }, { it.trackNumber }))
            SmartSort.Newest -> picked.sortedWith(compareByDescending<Track> { it.year }.thenBy { it.album.lowercase() }.thenBy { it.trackNumber })
            SmartSort.RecentlyAdded -> picked.sortedByDescending { it.dateAdded }
            SmartSort.MostPlayed -> picked.sortedByDescending { plays[it.id] ?: 0 }
            SmartSort.TopRated -> picked.sortedByDescending { ratings[it.id] ?: 0f }
            SmartSort.Random -> picked.shuffled(java.util.Random(id))
        }
        return if (limit > 0) sorted.take(limit) else sorted
    }

    companion object {
        val LOSSLESS = setOf("flac", "wav", "aif", "aiff", "alac", "ape", "wv", "dsf", "dff")
    }
}

/** The phone's smart playlists, kept in the app's files. */
class SmartPlaylists(context: Context) {
    private val file = File(context.filesDir, "smart-playlists.json")
    private val json = Json { ignoreUnknownKeys = true }
    private val _list = MutableStateFlow(runCatching { json.decodeFromString<List<SmartPlaylist>>(file.readText()) }.getOrDefault(emptyList()))
    val list: StateFlow<List<SmartPlaylist>> = _list.asStateFlow()

    @Synchronized fun save(p: SmartPlaylist) {
        val next = if (_list.value.any { it.id == p.id }) _list.value.map { if (it.id == p.id) p else it } else _list.value + p
        _list.value = next
        file.writeText(json.encodeToString(next))
    }

    @Synchronized fun delete(id: Long) {
        _list.value = _list.value.filterNot { it.id == id }
        file.writeText(json.encodeToString(_list.value))
    }
}
