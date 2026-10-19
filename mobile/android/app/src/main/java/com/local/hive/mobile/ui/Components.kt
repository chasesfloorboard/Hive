package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.SubcomposeAsyncImage
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive

/** Album art from MediaStore, with Hive's note glyph when a file has none. */
@Composable
fun Artwork(
    model: Any?,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(8.dp),
    fallback: ImageVector = Icons.Rounded.MusicNote,
) {
    val colors = Hive.colors
    Box(modifier.clip(shape).background(colors.control), contentAlignment = Alignment.Center) {
        SubcomposeAsyncImage(
            model = model,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            loading = { FallbackGlyph(fallback) },
            error = { FallbackGlyph(fallback) },
        )
    }
}

@Composable
private fun FallbackGlyph(icon: ImageVector) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = Hive.colors.textDimmer, modifier = Modifier.fillMaxSize(0.45f))
    }
}

data class TrackActions(
    val onPlayNext: (Track) -> Unit,
    val onAddToQueue: (Track) -> Unit,
    val onToggleLove: (Track) -> Unit,
    val onGoToAlbum: (Track) -> Unit,
    val onGoToArtist: (Track) -> Unit,
)

/** One song in a list: art, title, artist · album, Love, and the ⋮ menu. */
@Composable
fun TrackRow(
    track: Track,
    loved: Boolean,
    playing: Boolean,
    actions: TrackActions,
    onClick: () -> Unit,
    subtitle: String = listOf(track.artist, track.album).filter { it.isNotBlank() }.joinToString(" · "),
    leading: (@Composable () -> Unit)? = null,
) {
    val colors = Hive.colors
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 20.dp, end = 4.dp)
            .height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) leading() else Artwork(track.artworkUri, Modifier.size(46.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                track.title,
                color = if (playing) colors.accent else colors.text,
                fontSize = 16.sp,
                fontWeight = if (playing) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotBlank()) {
                Text(subtitle, color = colors.textDim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (loved) Icon(Icons.Rounded.Favorite, "Loved", tint = colors.accent, modifier = Modifier.size(16.dp))
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, "More options", tint = colors.textDim) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                MenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistAdd) { menu = false; actions.onPlayNext(track) }
                MenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; actions.onAddToQueue(track) }
                MenuItem(if (loved) "Remove from Favorites" else "Add to Favorites", if (loved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder) {
                    menu = false; actions.onToggleLove(track)
                }
                MenuItem("Go to album", Icons.Rounded.Album) { menu = false; actions.onGoToAlbum(track) }
                MenuItem("Go to artist", Icons.Rounded.Person) { menu = false; actions.onGoToArtist(track) }
            }
        }
    }
}

@Composable
private fun MenuItem(label: String, icon: ImageVector, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, leadingIcon = { Icon(icon, null) }, onClick = onClick)
}

/** "123 tracks" with Shuffle and Play all, as above every Samsung Music list. */
@Composable
fun ListHeader(count: Int, noun: String, onShuffle: (() -> Unit)?, onPlayAll: (() -> Unit)?) {
    val colors = Hive.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$count ${if (count == 1) noun else noun + "s"}", color = colors.textDim, fontSize = 14.sp, modifier = Modifier.weight(1f))
        if (onShuffle != null) RoundAction(Icons.Rounded.Shuffle, "Shuffle play", onShuffle)
        if (onPlayAll != null) RoundAction(Icons.Rounded.PlayArrow, "Play all", onPlayAll)
    }
}

@Composable
fun RoundAction(icon: ImageVector, label: String, onClick: () -> Unit, size: Dp = 40.dp) {
    val colors = Hive.colors
    Box(
        Modifier.padding(horizontal = 4.dp).size(size).clip(CircleShape).background(colors.control).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = colors.text, modifier = Modifier.size(size * 0.55f)) }
}

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    val colors = Hive.colors
    Column(modifier.fillMaxWidth().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, color = colors.text, fontSize = 17.sp, fontWeight = FontWeight.Medium)
        Text(body, color = colors.textDim, fontSize = 14.sp)
    }
}

fun formatDuration(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}
