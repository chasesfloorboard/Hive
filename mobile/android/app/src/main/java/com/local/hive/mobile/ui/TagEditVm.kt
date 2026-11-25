package com.local.hive.mobile.ui

import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.data.applying
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** Editing tags and covers: writing each song's edits (and covers) into its file + the PC, and the cover
 *  editor's helpers (a song's pictures, its full-size cover, save-to-gallery, download). From MainViewModel. */
class TagEditVm(private val app: HiveApp, private val scope: CoroutineScope) {
    private val dao = app.database.dao()
    private val nowPlaying = app.player.state

    /**
     * Writes each song's edit (and [covers], for all of them) into its file, then
     * hands the same changes to Hive on the PC (see [com.local.hive.mobile.link.PcEdits]).
     * Reports a line for the toast.
     */
    fun saveEdits(edits: Map<Track, com.local.hive.mobile.data.TagEdit>, covers: com.local.hive.mobile.data.CoverEdit? = null, onDone: (String) -> Unit) = scope.launch {
        val cover = covers?.takeIf { !it.isEmpty }
        val wanted = edits.filter { !it.value.isEmpty || cover != null }
        if (wanted.isEmpty()) { onDone("Nothing changed"); return@launch }
        // The playing song is reloaded at its place once its file is rewritten.
        val playing = nowPlaying.value.trackId
        val saved = mutableListOf<Track>()
        var problem: String? = null
        // Songs the file mirror keeps one to one: the phone's copy is rewritten here (seen at once) and the PC
        // writes the same edit into its own (PcEdits below); the mirror then makes the two one file again by
        // sending the newer one's tags. Nothing is marked "the same" while the files still differ.
        for ((track, edit) in wanted) {
            runCatching { com.local.hive.mobile.data.TagWriter.write(app, track, edit, cover) }
                .onSuccess { saved += track }
                .onFailure { problem = it.message ?: "A song couldn't be changed" }
            edit.lyrics?.let { app.lyricsStore.saveOwn(track.artist, track.title, it) }
        }
        if (saved.any { it.id == playing }) app.player.reloadCurrent()
        app.pcEdits.addTags(saved.associate { it.id to wanted.getValue(it) }.filterValues { !it.isEmpty })
        if (cover != null) {
            // Now Playing's turning covers are read from the files again.
            saved.forEach { java.io.File(app.cacheDir, "pictures/${it.id}").deleteRecursively() }
            val albums = saved.map { it.albumId }.distinct()
            albums.forEach { albumId ->
                java.io.File(app.cacheDir, "embedded-art-v2/$albumId.img").delete()
                java.io.File(app.cacheDir, "hq-art/$albumId.jpg").delete()
                java.io.File(app.cacheDir, "hq-art/$albumId.differs").delete()
            }
            cover.backs.forEach { (place, picture) -> app.pcEdits.addBackCover(saved.map { it.id }, place, picture) }
            cover.front?.let { front ->
                app.pcEdits.addCover(saved.map { it.id }, front)
                // The old cover is cached (Hive's own copy, Coil's, Android's thumbnails); the new one is
                // read afresh now, and again once Android has re-read the files and remade its thumbnails.
                refreshCovers(albums, front)
                scope.launch { kotlinx.coroutines.delay(4_000); refreshCovers(albums, front) }
            } ?: run {
                if (cover.clearAll || cover.removeFront) {
                    app.pcEdits.addCover(saved.map { it.id }, ByteArray(0))
                }
                coil3.SingletonImageLoader.get(app).memoryCache?.clear()
                forgetShownCovers()
            }
        }
        // Show the change at once: write the edited rows into the library DB now so the open album and lists
        // repopulate immediately. Without this they only updated after the full MediaStore rescan below, which
        // can take a second or two — long enough that it looked like nothing happened until the album was
        // reopened. The rescan stays authoritative and reconciles what this can't know (a new albumId when the
        // album name/artist changed; the cover is handled above).
        if (saved.isNotEmpty()) runCatching { dao.upsertTracks(saved.map { it.applying(wanted.getValue(it)) }) }
        app.requestRescan(delayMs = 0)
        app.sync.matchAgainNextSync()
        if (app.linkStore.pairing != null) scope.launch { kotlinx.coroutines.delay(3_000); app.sync.syncNow() }
        onDone(when {
            saved.isEmpty() -> problem ?: "Nothing was changed"
            saved.size < wanted.size -> "Changed ${saved.size} of ${countOf(wanted.size, "song")}. $problem"
            else -> "Saved " + if (saved.size == 1) "“${saved[0].title}”" else countOf(saved.size, "song")
        })
    }

    /** Hive's kept copy of each album's cover becomes [cover] at once (Android's own readers lag behind the file). */
    private fun refreshCovers(albumIds: List<Long>, cover: ByteArray) {
        val dir = java.io.File(app.cacheDir, "embedded-art-v2").apply { mkdirs() }
        albumIds.forEach { runCatching { java.io.File(dir, "$it.img").writeBytes(cover) } }
        // Only pictures in memory: the disk cache holds online covers, which didn't change.
        coil3.SingletonImageLoader.get(app).memoryCache?.clear()
        forgetShownCovers()
    }

    /** A song's pictures with their types (front and back covers), for the cover editor. */
    suspend fun pictures(track: Track) = com.local.hive.mobile.data.TagWriter.pictures(app, track)

    /** A song's own cover at full size, for saving it to the phone. */
    suspend fun fullCover(track: Track): ByteArray? = com.local.hive.mobile.data.TagWriter.cover(app, track)

    /** Saves a picture into the phone's Pictures/Hive, where the gallery shows it. */
    fun savePicture(bytes: ByteArray, name: String, onDone: (String) -> Unit) = scope.launch {
        val ok = kotlinx.coroutines.withContext(Dispatchers.IO) {
            runCatching {
                val png = bytes.size > 3 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte()
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name.replace(Regex("""[\\/:*?"<>|]"""), "_").take(80) + if (png) ".png" else ".jpg")
                    put(android.provider.MediaStore.Images.Media.MIME_TYPE, if (png) "image/png" else "image/jpeg")
                    put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Hive")
                }
                val uri = app.contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
                app.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            }.isSuccess
        }
        onDone(if (ok) "Cover saved to Pictures/Hive" else "Couldn't save the cover")
    }

    /** Downloads a picture (a cover found online). */
    suspend fun download(url: String): ByteArray? = kotlinx.coroutines.withContext(Dispatchers.IO) {
        runCatching { okhttp3.OkHttpClient().newCall(okhttp3.Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null } }.getOrNull()
    }
}
