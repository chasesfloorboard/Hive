package com.local.hive.mobile.soulseek

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.jaudiotagger.audio.AudioFileIO
import org.jaudiotagger.tag.FieldKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** A song Soulseek doesn't have, from YouTube: found, saved, repacked into a plain M4A and tagged (needs the internet). */
@RunWith(AndroidJUnit4::class)
class YouTubeFallbackTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun savesATaggedPlayableM4a() {
        val dir = File(context.cacheDir, "youtube-test").apply { deleteRecursively(); mkdirs() }
        try {
            val track = SoulseekRequest.Track("Eyes Without a Face", 298_000, artist = "Billy Idol", album = "Rebel Yell", year = "1983",
                artworkUrl = "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/18/05/fe/1805fea9-58d8-502a-573b-5711473bd5e4/13UABIM74015.rgb.jpg/600x600bb.jpg")
            val file = YouTubeFallback.fetch(context, "Billy Idol", "Rebel Yell", track, dir)
            assertTrue(file.name.endsWith(".m4a") && file.length() > 1_000_000)
            val audio = AudioFileIO.read(file)
            assertEquals("Eyes Without a Face", audio.tag.getFirst(FieldKey.TITLE))
            assertEquals("Billy Idol", audio.tag.getFirst(FieldKey.ARTIST))
            assertEquals("Rebel Yell", audio.tag.getFirst(FieldKey.ALBUM))
            assertEquals("1983", audio.tag.getFirst(FieldKey.YEAR))
            assertTrue("has its cover", audio.tag.firstArtwork?.binaryData?.isNotEmpty() == true)
            assertTrue("about five minutes long", audio.audioHeader.trackLength in 285..310)
            // Android itself reads it as a song of that length.
            val r = android.media.MediaMetadataRetriever()
            r.setDataSource(file.path)
            val ms = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong()
            r.release()
            assertTrue(ms in 285_000..310_000)
            file.copyTo(File(context.getExternalFilesDir(null), "youtube-fallback-test.m4a"), overwrite = true)
        } finally { dir.deleteRecursively() }
    }
}
