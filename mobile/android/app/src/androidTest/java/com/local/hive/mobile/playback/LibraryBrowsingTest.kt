package com.local.hive.mobile.playback

import android.content.ComponentName
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/** Browses Hive the way Android Auto does: the tree, an album, and playing a song from it. */
@RunWith(AndroidJUnit4::class)
class LibraryBrowsingTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    /** MediaBrowser calls belong on the main thread; results are awaited here. */
    private fun <T> onMain(block: () -> com.google.common.util.concurrent.ListenableFuture<T>): T {
        var future: com.google.common.util.concurrent.ListenableFuture<T>? = null
        instrumentation.runOnMainSync { future = block() }
        return future!!.get(20, TimeUnit.SECONDS)
    }

    @Test
    fun browsesTheLibraryAndPlaysAnAlbumFromTheChosenSong() {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val browser = onMain { MediaBrowser.Builder(context, token).buildAsync() }
        val root = onMain { browser.getLibraryRoot(null) }.value!!
        val top = onMain { browser.getChildren(root.mediaId, 0, 50, null) }.value!!.map { it.mediaMetadata.title.toString() }
        assertEquals(listOf("Favorites", "Playlists", "Albums", "Artists", "Recently Added"), top)

        val albums = onMain { browser.getChildren("albums", 0, 500, null) }.value!!
        assertTrue("the library has albums", albums.isNotEmpty())
        val album = albums.maxBy { a -> onMain { browser.getChildren(a.mediaId, 0, 200, null) }.value!!.size }
        val songs = onMain { browser.getChildren(album.mediaId, 0, 200, null) }.value!!
        assertTrue(songs.all { it.mediaMetadata.isPlayable == true && '|' in it.mediaId })

        // Choosing the second song queues the album and starts there, as a browser does it (an id, no address).
        val chosen = songs[minOf(1, songs.size - 1)]
        instrumentation.runOnMainSync {
            browser.setMediaItem(MediaItem.Builder().setMediaId(chosen.mediaId).build())
            browser.prepare()
        }
        Thread.sleep(2_000)
        var count = 0; var index = -1
        instrumentation.runOnMainSync { count = browser.mediaItemCount; index = browser.currentMediaItemIndex; browser.stop(); browser.release() }
        assertEquals(songs.size, count)
        assertEquals(minOf(1, songs.size - 1), index)
    }
}
