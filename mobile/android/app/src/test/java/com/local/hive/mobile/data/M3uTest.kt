package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class M3uTest {
    private fun track(id: Long, title: String, artist: String, file: String, folder: String = "Music/Album") =
        Track(id, title, artist, "Album", "", 1, 200_000, 1, 1, 2020, "", folder, file, 0, 0)

    private val library = listOf(track(1, "One", "A", "01 One.mp3"), track(2, "Two", "B", "02 Two.flac"), track(3, "Two", "B", "02 Two.flac", "Music/Other"))

    @Test fun readsHiveAndMusicBeeFiles() {
        val text = "\uFEFF#EXTM3U\r\n#EXTINF:200,A - One\r\nC:\\Music\\Album\\01 One.mp3\r\n#EXTINF:-1,Just A Title\r\n/sdcard/Music/x.mp3\r\n# a comment\r\nrelative/02 Two.flac\r\n"
        val e = M3u.parse(text)
        assertEquals(3, e.size)
        assertEquals(M3u.Entry("C:/Music/Album/01 One.mp3", "A", "One", 200), e[0])
        assertEquals(M3u.Entry("/sdcard/Music/x.mp3", "", "Just A Title", -1), e[1])
        assertEquals(M3u.Entry("relative/02 Two.flac", "", "", -1), e[2])
    }

    @Test fun matchesByFileNameThenByTags() {
        val entries = M3u.parse("#EXTM3U\nMusic/Other/02 Two.flac\n#EXTINF:200,A - One\n/elsewhere/renamed.mp3\nnope.mp3\n")
        val matched = M3u.match(entries, library) { e -> library.firstOrNull { it.title == e.title && it.artist == e.artist } }
        assertEquals(3L, matched[0]?.id) // the same file name in two folders: the matching folder wins
        assertEquals(1L, matched[1]?.id) // not by name, so by artist and title
        assertNull(matched[2])
    }

    @Test fun exportReadsBack() {
        val back = M3u.match(M3u.parse(M3u.write(library.take(2))), library) { null }
        assertEquals(listOf(1L, 2L), back.map { it?.id })
    }
}
