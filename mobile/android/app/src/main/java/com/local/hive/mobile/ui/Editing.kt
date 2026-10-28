package com.local.hive.mobile.ui

import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.data.TagEdit
import com.local.hive.mobile.data.TagWriter
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.stream.AmCard
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Hive's library editing on the phone: the tag editor, Change cover and
 * Auto-tag, opened from a song's menu, an album page or picked songs. Each
 * one asks Android once for leave to change the files, then writes them (see
 * [MainViewModel.saveEdits]).
 */
class Editor(
    val editTags: (List<Track>) -> Unit,
    val changeCover: (List<Track>) -> Unit,
    val autoTag: (List<Track>) -> Unit,
)

val LocalEditor = staticCompositionLocalOf { Editor({}, {}, {}) }

/** What HiveRoot has open: one of the three sheets, for these songs. */
sealed class EditSheet(val tracks: List<Track>) {
    class Tags(tracks: List<Track>) : EditSheet(tracks)
    class Cover(tracks: List<Track>) : EditSheet(tracks)
    class AutoTag(tracks: List<Track>) : EditSheet(tracks)
}

@Composable
fun EditSheets(vm: MainViewModel, sheet: EditSheet?, onDismiss: () -> Unit, onToast: (String) -> Unit) {
    when (sheet) {
        is EditSheet.Tags -> TagEditorSheet(vm, sheet.tracks, onDismiss, onToast)
        is EditSheet.Cover -> CoverSheet(vm, sheet.tracks, onDismiss, onToast)
        is EditSheet.AutoTag -> AutoTagSheet(vm, sheet.tracks, onDismiss, onToast)
        null -> {}
    }
}

/**
 * Android's "Allow Hive to modify these files?" for [tracks], then [onAllowed]
 * with the songs Hive can write into. Songs whose format Hive can't write are
 * left out, and said so.
 */
@Composable
fun rememberWriteAccess(onToast: (String) -> Unit): (List<Track>, (List<Track>) -> Unit) -> Unit {
    val context = LocalContext.current
    var waiting by remember { mutableStateOf<Pair<List<Track>, (List<Track>) -> Unit>?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val w = waiting
        waiting = null
        if (result.resultCode == android.app.Activity.RESULT_OK && w != null) w.second(w.first)
    }
    return { tracks, onAllowed ->
        val writable = tracks.filter(TagWriter::canWrite)
        when {
            writable.isEmpty() -> onToast("Hive can't write tags into ${tracks.firstOrNull()?.fileName?.substringAfterLast('.')?.let { ".$it" } ?: "these"} files")
            Build.VERSION.SDK_INT < Build.VERSION_CODES.R -> onAllowed(writable)
            else -> {
                if (writable.size < tracks.size) onToast("${countOf(tracks.size - writable.size, "song")} can't be edited (format)")
                waiting = writable to onAllowed
                val request = MediaStore.createWriteRequest(context.contentResolver, writable.map { it.uri })
                launcher.launch(IntentSenderRequest.Builder(request.intentSender).build())
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Hive.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.control, contentColor = c.text,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp), scrimColor = Color.Black.copy(alpha = 0.45f),
        dragHandle = { Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(36.dp, 4.dp).clip(HiveShape.pill).background(c.text.copy(alpha = 0.22f))) },
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

/** The songs being edited: a cover, a title and how many. */
@Composable
private fun EditHeader(label: String, tracks: List<Track>) {
    val c = Hive.colors
    val first = tracks.first()
    val oneAlbum = tracks.all { it.albumId == first.albumId }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Artwork(first.artworkUri, Modifier.size(56.dp), HiveShape.art, Icons.Rounded.LibraryMusic)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            HiveLabel(label)
            Text(if (tracks.size == 1) first.title else if (oneAlbum) first.album.ifBlank { "Unknown album" } else countOf(tracks.size, "song"), style = HiveText.year, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (tracks.size == 1) first.artist else countOf(tracks.size, "song") + if (oneAlbum) " · " + first.displayAlbumArtist else "", style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ---- the tag editor ----

/**
 * Hive's tag editor for the phone. One song shows all its fields; several
 * show what they share, and a field left as "Keep each song's" isn't touched.
 */
@Composable
fun TagEditorSheet(vm: MainViewModel, tracks: List<Track>, onDismiss: () -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val write = rememberWriteAccess(onToast)
    val single = tracks.size == 1
    // Each field starts as the songs' shared value, or blank with a "Keep each song's" hint when they differ.
    fun shared(of: (Track) -> String): String? = tracks.map(of).distinct().singleOrNull()
    val start = remember(tracks) {
        linkedMapOf(
            "Title" to shared { it.title }, "Artist" to shared { it.artist }, "Album" to shared { it.album },
            "Album artist" to shared { it.albumArtist }, "Genre" to shared { it.genre },
            "Year" to shared { if (it.year > 0) it.year.toString() else "" },
            "Track" to shared { if (it.trackNumber > 0) it.trackNumber.toString() else "" },
            "Disc" to shared { if (it.discNumber > 0) it.discNumber.toString() else "" },
        )
    }
    val values = remember(tracks) { androidx.compose.runtime.mutableStateMapOf<String, String>().apply { start.forEach { (k, v) -> put(k, v.orEmpty()) } } }
    var saving by remember { mutableStateOf(false) }
    // A field counts as changed when it differs from where it started (for mixed fields: when typed in).
    fun changed(k: String): String? = values[k]?.takeIf { v -> start[k]?.let { it != v } ?: v.isNotEmpty() }
    val edit = TagEdit(
        title = changed("Title"), artist = changed("Artist"), album = changed("Album"), albumArtist = changed("Album artist"),
        genre = changed("Genre"), year = changed("Year"), track = changed("Track"), disc = changed("Disc"),
    )

    EditSheet(onDismiss) {
        EditHeader(if (single) "Edit tags" else "Edit tags of ${countOf(tracks.size, "song")}", tracks)
        val fields = if (single) start.keys.toList() else start.keys.filter { it != "Title" && it != "Track" }
        fields.chunked(2).forEach { row ->
            // Short fields share a line; names get their own.
            if (row.all { it in setOf("Year", "Track", "Disc") }) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { k -> Field(values, start, k, Modifier.weight(1f)) }
            } else row.forEach { k -> Field(values, start, k, Modifier.fillMaxWidth()) }
        }
        if (!single) Text("Fields left as “Keep each song's” stay as they are in each song.", style = HiveText.small, color = c.textDim)
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            HiveButton("Cancel") { onDismiss() }
            HiveButton(if (saving) "Saving…" else "Save", primary = true, enabled = !saving && !edit.isEmpty) {
                write(tracks) { allowed ->
                    saving = true
                    vm.saveEdits(allowed.associateWith { edit }) { onToast(it); onDismiss() }
                }
            }
        }
    }
}

@Composable
private fun Field(values: MutableMap<String, String>, start: Map<String, String?>, key: String, modifier: Modifier) {
    val number = key in setOf("Year", "Track", "Disc")
    val mixed = start[key] == null && values[key].isNullOrEmpty()
    HiveField(
        values[key].orEmpty(), { values[key] = if (number) it.filter(Char::isDigit).take(4) else it },
        if (mixed) "$key · keep each song's" else key, modifier,
        type = if (number) KeyboardType.Number else KeyboardType.Text,
        capitalization = if (number) KeyboardCapitalization.None else KeyboardCapitalization.Words,
    )
}

// ---- Change cover ----

/** Re-encodes a picture as a JPEG of at most 1600 px, as Hive keeps covers sensible in size. */
private suspend fun coverJpeg(bytes: ByteArray): ByteArray? = withContext(Dispatchers.Default) {
    runCatching {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }.also { android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it) }
        if (bounds.outWidth <= 0) return@runCatching null
        val jpeg = bytes.size > 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte()
        if (jpeg && maxOf(bounds.outWidth, bounds.outHeight) <= 1600) return@runCatching bytes
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1600) sample *= 2
        val decoded = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: return@runCatching null
        val scale = minOf(1f, 1600f / maxOf(decoded.width, decoded.height))
        val sized = if (scale < 1f) android.graphics.Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt(), (decoded.height * scale).toInt(), true) else decoded
        java.io.ByteArrayOutputStream().also { sized.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
    }.getOrNull()
}

/** Apple's covers come as any size asked for: the largest Hive keeps. */
private fun bigCover(url: String) = url.replace(Regex("""/\d+x\d+bb\.jpg$"""), "/1400x1400bb.jpg")

/** Change cover: a photo from the phone, or a cover found online, written into every song. */
@Composable
fun CoverSheet(vm: MainViewModel, tracks: List<Track>, onDismiss: () -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val write = rememberWriteAccess(onToast)
    val first = tracks.first()
    var query by remember { mutableStateOf("${first.displayAlbumArtist} ${first.album}".trim()) }
    var results by remember { mutableStateOf<List<AmCard>?>(null) }
    var picked by remember { mutableStateOf<Any?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { results = vm.findAlbums(query) }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) picked = uri }

    fun save() {
        val choice = picked ?: return
        busy = true
        scope.launch {
            val raw = when (choice) {
                is android.net.Uri -> withContext(Dispatchers.IO) { runCatching { context.contentResolver.openInputStream(choice)?.use { it.readBytes() } }.getOrNull() }
                is String -> vm.download(choice)
                else -> null
            }
            val jpeg = raw?.let { coverJpeg(it) }
            if (jpeg == null) { busy = false; onToast("Couldn't read that picture"); return@launch }
            write(tracks) { allowed -> vm.saveEdits(allowed.associateWith { TagEdit() }, jpeg) { onToast(if (it.startsWith("Saved")) "Cover changed" else it); onDismiss() } }
        }
    }

    EditSheet(onDismiss) {
        EditHeader("Change cover", tracks)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Artwork(picked ?: first.artworkUri, Modifier.size(120.dp), HiveShape.art, Icons.Rounded.Album, elevation = 12.dp)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (picked == null) "The cover now. Pick a new one below, or a photo from your phone." else "The new cover. Save writes it into ${if (tracks.size == 1) "the song" else countOf(tracks.size, "song")}.", style = HiveText.small, color = c.textDim)
                HiveButton("Choose a photo") { photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HiveField(query, { query = it }, "Search covers online", Modifier.weight(1f), onDone = { results = null; scope.launch { results = vm.findAlbums(query) } })
            HiveButton("Search") { results = null; scope.launch { results = vm.findAlbums(query) } }
        }
        val found = results
        when {
            found == null -> Busy("Looking for covers…")
            found.isEmpty() -> Text("No covers found. Try other words, or choose a photo.", style = HiveText.small, color = c.textDim)
            else -> LazyVerticalGrid(GridCells.Fixed(3), Modifier.heightIn(max = 380.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(found.filter { it.artwork.isNotBlank() }, key = { it.id }) { a ->
                    val big = bigCover(a.artwork)
                    Column(Modifier.clip(RoundedCornerShape(10.dp)).clickable { picked = big }) {
                        Box(Modifier.fillMaxWidth().aspectRatio(1f).then(if (picked == big) Modifier.border(2.dp, c.accent, HiveShape.art) else Modifier)) {
                            Artwork(a.artwork, Modifier.fillMaxWidth().aspectRatio(1f), HiveShape.art, Icons.Rounded.Image)
                        }
                        Text(a.name, style = HiveText.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                        Text(a.curator.replace(Regex("""^(Album|Single|EP)\W+"""), ""), style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            HiveButton("Cancel") { onDismiss() }
            HiveButton(if (busy) "Saving…" else "Save cover", primary = true, enabled = picked != null && !busy) { save() }
        }
    }
}

// ---- Auto-tag ----

/**
 * The songs of an album matched to a release's songs: by track number when
 * the album has them, else by title, else in order.
 */
internal fun <T> matchRelease(tracks: List<Track>, release: List<T>, title: (T) -> String): List<Pair<Track, Int>> {
    fun norm(s: String) = s.lowercase().replace(Regex("""\s*[(\[].*?[)\]]"""), "").replace(Regex("[^a-z0-9]+"), "")
    val numbered = tracks.all { it.trackNumber in 1..release.size } && tracks.map { it.discNumber to it.trackNumber }.distinct().size == tracks.size && tracks.map { it.discNumber }.distinct().size == 1
    if (numbered) return tracks.map { it to it.trackNumber - 1 }
    val left = release.indices.toMutableList()
    val byTitle = tracks.map { t -> t to left.firstOrNull { norm(title(release[it])) == norm(t.title) }?.also { left.remove(it) } }
    if (byTitle.count { it.second != null } * 2 >= tracks.size) return byTitle.mapNotNull { (t, i) -> i?.let { t to it } }
    return tracks.sortedWith(compareBy({ it.discNumber }, { it.trackNumber }, { it.fileName })).take(release.size).mapIndexed { i, t -> t to i }
}

/** Auto-tag: pick the album on Apple Music, check the matches, and every song gets the release's tags (and cover). */
@Composable
fun AutoTagSheet(vm: MainViewModel, tracks: List<Track>, onDismiss: () -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val scope = rememberCoroutineScope()
    val write = rememberWriteAccess(onToast)
    val first = tracks.first()
    var query by remember { mutableStateOf("${first.displayAlbumArtist} ${first.album}".trim()) }
    var results by remember { mutableStateOf<List<AmCard>?>(null) }
    var release by remember { mutableStateOf<com.local.hive.mobile.stream.AmCollection?>(null) }
    var loading by remember { mutableStateOf(false) }
    var withCover by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { results = vm.findAlbums(query) }

    EditSheet(onDismiss) {
        EditHeader("Auto-tag", tracks)
        val r = release
        if (r == null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HiveField(query, { query = it }, "Find the album on Apple Music", Modifier.weight(1f), onDone = { results = null; scope.launch { results = vm.findAlbums(query) } })
                HiveButton("Search") { results = null; scope.launch { results = vm.findAlbums(query) } }
            }
            val found = results
            when {
                loading || found == null -> Busy(if (loading) "Opening the album…" else "Looking for the album…")
                found.isEmpty() -> Text("Nothing found. Try the album's name alone.", style = HiveText.small, color = c.textDim)
                else -> found.take(12).forEach { a ->
                    Row(Modifier.fillMaxWidth().clip(HiveShape.row).clickable {
                        loading = true
                        scope.launch {
                            release = runCatching { vm.appleAlbum(a.url) }.getOrNull()
                            loading = false
                            if (release == null) onToast("Couldn't open that album")
                        }
                    }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Artwork(a.artwork, Modifier.size(52.dp), HiveShape.thumb, Icons.Rounded.Album)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(a.name, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(a.curator.replace(Regex("""^(Album|Single|EP)\W+"""), ""), style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        } else {
            val matches = remember(r) { matchRelease(tracks, r.songs) { it.title } }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Artwork(r.artwork, Modifier.size(64.dp), HiveShape.art, Icons.Rounded.Album)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(r.name, style = HiveText.rowStrong, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(r.curator, r.songs.firstNotNullOfOrNull { it.year.ifBlank { null } }, countOf(r.songs.size, "song")).joinToString(" · "), style = HiveText.small, color = c.textDim)
                }
                Text("Change", style = HiveText.rowStrong, color = c.accent, modifier = Modifier.clip(HiveShape.pill).clickable { release = null }.padding(10.dp))
            }
            HiveLabel("Your songs become")
            matches.sortedBy { it.second }.forEach { (t, i) ->
                val s = r.songs[i]
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${i + 1}", style = HiveText.numbers, color = c.textDim, modifier = Modifier.width(28.dp))
                    Column(Modifier.weight(1f)) {
                        Text(s.title, style = HiveText.body, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (s.title != t.title) Text("was “${t.title}”", style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val unmatched = tracks.size - matches.size
            if (unmatched > 0) Text("${countOf(unmatched, "song")} didn't match a song of this album and stay as they are.", style = HiveText.small, color = c.textDim)
            Row(Modifier.fillMaxWidth().clip(HiveShape.row).clickable { withCover = !withCover }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Use the album's cover too", style = HiveText.body, color = c.text, modifier = Modifier.weight(1f))
                HiveToggle(listOf("No", "Yes"), if (withCover) 1 else 0, { withCover = it == 1 })
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                HiveButton("Cancel") { onDismiss() }
                HiveButton(if (busy) "Saving…" else "Apply", primary = true, enabled = matches.isNotEmpty() && !busy) {
                    busy = true
                    scope.launch {
                        val cover = if (withCover && r.artwork.isNotBlank()) vm.download(bigCover(r.artwork))?.let { coverJpeg(it) } else null
                        val year = r.songs.firstNotNullOfOrNull { it.year.take(4).ifBlank { null } }
                        val genre = r.songs.firstNotNullOfOrNull { it.genre.ifBlank { null } }
                        val edits = matches.associate { (t, i) ->
                            val s = r.songs[i]
                            t to TagEdit(title = s.title, artist = s.artist.ifBlank { r.curator }, album = r.name, albumArtist = r.curator, year = year, genre = genre, track = "${i + 1}")
                        }
                        write(edits.keys.toList()) { allowed -> vm.saveEdits(edits.filterKeys { it in allowed }, cover) { onToast(it); onDismiss() } }
                        busy = false
                    }
                }
            }
        }
    }
}
