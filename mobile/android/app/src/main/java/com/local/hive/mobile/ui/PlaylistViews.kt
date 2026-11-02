package com.local.hive.mobile.ui

import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveIcons
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText

/** A list of songs (a playlist, a genre) as its songs, or the albums and artists they're from. */
enum class SongsView(val label: String, val noun: String) { Tracks("Tracks", "track"), Albums("Albums", "album"), Artists("Artists", "artist") }

/** How a list's albums or artists are ordered. */
enum class GroupSort(val label: String) { Most("Most songs"), Name("Name") }

/** Albums or artists with songs in a list: [count] of them, from [albums] albums. [track] stands for the group (to open it, and for a picture). */
data class SongGroup(val name: String, val artist: String, val track: Track, val count: Int, val albums: Int = 1)

private fun List<SongGroup>.sorted(sort: GroupSort) = when (sort) {
    GroupSort.Most -> sortedWith(compareByDescending<SongGroup> { it.count }.thenBy { it.name.lowercase() })
    GroupSort.Name -> LibrarySort.sorted(this) { it.name }
}

/** The albums [tracks] are from. */
fun albumsOf(tracks: List<Track>, sort: GroupSort = GroupSort.Most): List<SongGroup> = tracks.groupBy { it.albumId }
    .map { (_, songs) -> SongGroup(songs.first().album, songs.first().displayAlbumArtist, songs.first(), songs.size) }
    .sorted(sort)

/** The artists of [tracks]; the picture is their album with the most songs here. */
fun artistsOf(tracks: List<Track>, sort: GroupSort = GroupSort.Most): List<SongGroup> = tracks.filter { it.artist.isNotBlank() && it.artist != "<unknown>" }
    .groupBy { it.artist.trim().lowercase() }
    .map { (_, songs) ->
        val perAlbum = songs.groupingBy { it.albumId }.eachCount()
        val album = perAlbum.maxBy { it.value }.key
        SongGroup(songs.first().artist.trim(), "", songs.first { it.albumId == album }, songs.size, perAlbum.size)
    }
    .sorted(sort)

/**
 * The list's one dropdown, as Samsung Music has it: what's shown (Tracks, Albums or Artists, with how
 * many of each) and its order, in a single menu under the view's name. [detail] sits beside it
 * (how many, the order, a hint); Shuffle and Play follow when given.
 */
@Composable
fun SongsHeader(
    view: SongsView,
    counts: Map<SongsView, Int>,
    onView: (SongsView) -> Unit,
    sorts: List<String>,
    sort: Int,
    onSort: (Int) -> Unit,
    detail: String,
    onShuffle: (() -> Unit)? = null,
    onPlay: (() -> Unit)? = null,
) {
    val c = Hive.colors
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().height(52.dp).padding(start = 10.dp, end = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box {
            Row(Modifier.height(40.dp).clip(HiveShape.pill).clickable { open = true }.padding(start = 10.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(view.label, style = HiveText.rowStrong, color = c.text)
                Icon(Icons.Rounded.ArrowDropDown, "Show tracks, albums or artists, and their order", tint = c.textDim, modifier = Modifier.size(22.dp))
            }
            HiveMenu(open, { open = false }) {
                Text("Show", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(start = 12.dp, top = 6.dp, bottom = 4.dp))
                SongsView.entries.forEach { v ->
                    HiveMenuItem("${v.label} · ${"%,d".format(counts[v] ?: 0)}", if (v == view) Icons.Rounded.Check else null) { open = false; onView(v) }
                }
                if (sorts.size > 1) {
                    HiveMenuDivider()
                    Text("Sort by", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(start = 12.dp, top = 6.dp, bottom = 4.dp))
                    sorts.forEachIndexed { i, s -> HiveMenuItem(s, if (i == sort) Icons.Rounded.Check else null) { open = false; onSort(i) } }
                }
            }
        }
        Text(detail, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 6.dp))
        if (onShuffle != null) ControlButton(HiveIcons.Shuffle, "Shuffle", onShuffle, size = 38.dp)
        if (onPlay != null) { Spacer(Modifier.width(8.dp)); AccentPlayButton(false, onPlay, size = 38.dp) }
    }
}

/** How many tracks, albums and artists [tracks] make, for [SongsHeader]'s menu. */
fun songsCounts(tracks: List<Track>, songs: Int = tracks.size) = mapOf(
    SongsView.Tracks to songs,
    SongsView.Albums to tracks.distinctBy { it.albumId }.size,
    SongsView.Artists to tracks.filter { it.artist.isNotBlank() && it.artist != "<unknown>" }.distinctBy { it.artist.trim().lowercase() }.size,
)

/** [SongsHeader]'s line beside the menu for albums or artists: how many, and their order. */
fun groupDetail(view: SongsView, counts: Map<SongsView, Int>, sort: GroupSort) = "${countOf(counts[view] ?: 0, view.noun)} · ${sort.label}"

/**
 * The albums or artists of [tracks] as list items, each with how many of its songs are in the list:
 * album covers two by two, as Samsung Music's grid; artists as rows in the list's glass panel.
 */
fun LazyListScope.songGroups(vm: MainViewModel, view: SongsView, tracks: List<Track>, actions: TrackActions, sort: GroupSort) {
    when (view) {
        SongsView.Tracks -> Unit
        SongsView.Albums -> {
            val albums = albumsOf(tracks, sort)
            if (albums.isEmpty()) item { EmptyState("No albums here", "") }
            albums.chunked(2).forEach { row ->
                item(key = "ga${row.first().track.albumId}") {
                    CoverRow(row) { a, m ->
                        CoverCard(Uri.parse("content://media/external/audio/albumart/${a.track.albumId}"), a.name.ifBlank { "Unknown album" },
                            "${countOf(a.count, "song")} · ${a.artist.ifBlank { "Unknown artist" }}", m,
                            artModifier = Modifier.sharedCover("album-${a.track.albumId}")) { actions.onGoToAlbum(a.track) }
                    }
                }
            }
        }
        SongsView.Artists -> {
            val artists = artistsOf(tracks, sort)
            if (artists.isEmpty()) item { EmptyState("No artists here", "") }
            else {
                item(key = "gr-top") { PanelTop() }
                items(artists, key = { "gr" + it.name.lowercase() }) { a -> PanelSlice { GroupArtistRow(vm, a) { actions.onGoToArtist(a.track) } } }
                item(key = "gr-bottom") { PanelBottom() }
            }
        }
    }
}

/** An artist with songs in a list: Hive's photo of them once found, how many songs, from how many albums. */
@Composable
private fun GroupArtistRow(vm: MainViewModel, a: SongGroup, onClick: () -> Unit) {
    val photo = rememberArtistPhoto(vm, a.name)
    LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.track.albumId}"), Icons.Rounded.Person, a.name,
        "${countOf(a.count, "song")} · ${countOf(a.albums, "album")}", round = true, onClick = onClick)
}
