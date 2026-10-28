package com.local.hive.mobile.ui

import android.content.Intent
import android.media.MediaMetadataRetriever
import android.os.Build
import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.automirrored.rounded.StarHalf
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.PlayStats
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the file itself says about its audio. */
private data class AudioFormat(val mime: String?, val bitrate: Int?, val sampleRate: Int?, val bitsPerSample: Int?)

private suspend fun readFormat(context: android.content.Context, track: Track): AudioFormat = withContext(Dispatchers.IO) {
    runCatching {
        MediaMetadataRetriever().use { r ->
            r.setDataSource(context, track.uri)
            fun int(key: Int) = r.extractMetadata(key)?.toIntOrNull()
            AudioFormat(
                mime = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE),
                bitrate = int(MediaMetadataRetriever.METADATA_KEY_BITRATE),
                sampleRate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) int(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE) else null,
                bitsPerSample = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) int(MediaMetadataRetriever.METADATA_KEY_BITS_PER_SAMPLE) else null,
            )
        }
    }.getOrDefault(AudioFormat(null, null, null, null))
}

/**
 * Hive's track info for a phone song: its tags, the file's format, size and
 * place, and how often it has been played here, with Share and Go to album.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackInfoSheet(vm: MainViewModel, track: Track, onDismiss: () -> Unit, onOpenAlbum: (Track) -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val format by produceState<AudioFormat?>(null, track.id) { value = readFormat(context, track) }
    val stats by produceState<PlayStats?>(null, track.id) { value = vm.playStats(track.id) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val ext = track.fileName.substringAfterLast('.', "").uppercase().ifBlank { null }

    ModalBottomSheet(
        onDismissRequest = onDismiss, sheetState = sheet, containerColor = c.control, contentColor = c.text,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp), scrimColor = Color.Black.copy(alpha = 0.45f),
        dragHandle = { Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(36.dp, 4.dp).clip(HiveShape.pill).background(c.text.copy(alpha = 0.22f))) },
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 12.dp)) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                // Hold the cover: save it to the phone at full size, or change it.
                var coverMenu by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
                val editor = LocalEditor.current
                val toast = LocalToast.current
                val scope = androidx.compose.runtime.rememberCoroutineScope()
                val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
                Box {
                    Artwork(track.artworkUri, Modifier.size(64.dp).pressable(onClick = {}, onLongClick = { haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); coverMenu = true }), HiveShape.art, Icons.Rounded.LibraryMusic)
                    HiveMenu(coverMenu, { coverMenu = false }) {
                        HiveMenuItem("Save cover to phone", Icons.Rounded.Download) {
                            coverMenu = false
                            scope.launch {
                                val bytes = vm.fullCover(track)
                                if (bytes == null) toast("This song has no cover of its own") else vm.savePicture(bytes, "${track.displayAlbumArtist} - ${track.album.ifBlank { track.title }}", toast)
                            }
                        }
                        HiveMenuItem("Change cover", Icons.Rounded.Image) { coverMenu = false; onDismiss(); editor.changeCover(listOf(track)) }
                    }
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    HiveLabel("Track info")
                    Text(track.title, style = HiveText.year, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(track.artist, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            val ratings by vm.ratings.collectAsStateWithLifecycle()
            Stars(ratings[track.id] ?: 0f, Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) { vm.rate(track.id, it) }
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                InfoAction("Go to album", Icons.Rounded.Album) { onDismiss(); onOpenAlbum(track) }
                val editor = LocalEditor.current
                InfoAction("Edit tags", Icons.Rounded.Edit) { onDismiss(); editor.editTags(listOf(track)) }
                InfoAction("Share", Icons.Rounded.Share) {
                    val send = Intent(Intent.ACTION_SEND).setType("audio/*").putExtra(Intent.EXTRA_STREAM, track.uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    runCatching { context.startActivity(Intent.createChooser(send, track.title)) }
                }
            }
            InfoGroup("Song") {
                InfoRow("Album", track.album)
                InfoRow("Album artist", track.albumArtist)
                InfoRow("Year", track.year.takeIf { it > 0 }?.toString())
                InfoRow("Genre", track.genre)
                InfoRow("Track", listOfNotNull(track.trackNumber.takeIf { it > 0 }?.toString(), track.discNumber.takeIf { it > 0 }?.let { "Disc $it" }).joinToString(" · "))
                InfoRow("Length", formatDuration(track.durationMs))
                InfoRow("Favorite", if (track.id in loved) "Yes" else "No")
            }
            InfoGroup("Listening") {
                InfoRow("Plays on this phone", stats?.plays?.toString() ?: "…")
                InfoRow("Last played", stats?.lastPlayed?.let { DateUtils.getRelativeTimeSpanString(it).toString() } ?: if (stats == null) "…" else "Never")
                InfoRow("Added", DateUtils.formatDateTime(context, track.dateAdded, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_YEAR))
            }
            InfoGroup("File") {
                InfoRow("Format", listOfNotNull(ext, format?.mime?.substringAfter('/')?.takeIf { ext == null }).joinToString(" · ").ifBlank { null })
                InfoRow("Bitrate", format?.bitrate?.let { "${it / 1000} kbps" })
                InfoRow("Sample rate", format?.sampleRate?.let { "%.1f kHz".format(it / 1000.0) + (format?.bitsPerSample?.let { b -> " · $b-bit" } ?: "") })
                InfoRow("Size", Formatter.formatShortFileSize(context, track.sizeBytes))
                InfoRow("Location", track.folder.trimEnd('/') + "/" + track.fileName)
            }
        }
    }
}

@Composable
private fun InfoAction(label: String, icon: ImageVector, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.height(40.dp).clip(HiveShape.pill).background(c.bg.copy(alpha = 0.45f)).clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, null, tint = c.textDim, modifier = Modifier.size(18.dp))
        Text(label, style = HiveText.pill, color = c.text)
    }
}

@Composable
private fun InfoGroup(title: String, content: @Composable () -> Unit) {
    Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp).fillMaxWidth().clip(HiveShape.panel).background(Hive.colors.bg.copy(alpha = 0.35f)).padding(vertical = 8.dp)) {
        HiveLabel(title, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        content()
    }
}

@Composable
private fun InfoRow(label: String, value: String?) {
    if (value.isNullOrBlank()) return
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 7.dp), verticalAlignment = Alignment.Top) {
        Text(label, style = HiveText.small, color = c.textDim, modifier = Modifier.width(132.dp))
        Text(value, style = HiveText.body, color = c.text, modifier = Modifier.weight(1f))
    }
}

/** Five stars, as Hive rates songs: tap a star to set it, tap it again to clear. */
@Composable
fun Stars(stars: Float, modifier: Modifier = Modifier, onRate: (Float) -> Unit) {
    val c = Hive.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        (1..5).forEach { n ->
            val filled = stars >= n
            val half = !filled && stars >= n - 0.5f
            Box(Modifier.size(40.dp).clip(androidx.compose.foundation.shape.CircleShape).clickable { onRate(if (stars == n.toFloat()) 0f else n.toFloat()) }, contentAlignment = Alignment.Center) {
                Icon(
                    when { filled -> Icons.Rounded.Star; half -> Icons.AutoMirrored.Rounded.StarHalf; else -> Icons.Rounded.StarBorder },
                    "$n star" + if (n > 1) "s" else "", tint = if (filled || half) c.accent else c.textDimmer, modifier = Modifier.size(26.dp),
                )
            }
        }
        if (stars > 0) Text(if (stars % 1f == 0f) "${stars.toInt()} of 5" else "$stars of 5", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(start = 6.dp))
    }
}
