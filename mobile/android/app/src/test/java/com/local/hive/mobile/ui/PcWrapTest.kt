package com.local.hive.mobile.ui

import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.link.HiveLinkClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class PcWrapTest {
    // Shaped like Hive's GET /api/wrap answer.
    private val json = """
        {"year":2026,"totalSeconds":7200.5,"totalPlays":40,"uniqueArtists":7,"uniqueAlbums":9,"longestStreak":4,
         "topTrack":{"key":"Black\u0000Pearl Jam","plays":12,"album":"Ten","cover":"aaaa.jpg"},
         "topArtists":[{"name":"Pearl Jam","plays":12,"cover":""}],
         "topAlbums":[{"album":"Ten","artist":"Pearl Jam","plays":12,"cover":"aaaa.jpg"},{"album":"Pink Moon","artist":"Nick Drake","plays":3,"cover":"https://x/pm.jpg"}],
         "topGenres":[{"name":"Grunge","seconds":3000,"album":"Ten","artist":"Pearl Jam","cover":"aaaa.jpg"}],
         "topDay":{"date":"2026-03-14","seconds":1800},
         "monthly":[{"month":"2026-03","seconds":3600},{"month":"2026-10","seconds":3600.5}],
         "topMonth":{"month":"2026-03","seconds":3600},
         "imported":true,"trackingSource":"musicbee-wrapped + hive-events"}
    """.trimIndent()

    @Test fun showsHivesNumbersWithPhoneCoversWhereThePhoneHasTheAlbum() {
        val pc = HiveLinkClient().parseWrap(json)
        val w = Wrap.fromPc(pc, listOf(AlbumSummary(77, "Ten", "Pearl Jam", 1991, 11))) { "http://pc/api/cover?name=$it" }
        assertTrue(w.fromPc)
        assertEquals(40, w.plays)
        assertEquals(7_200_500L, w.listenedMs)
        assertEquals(Wrap.Ranked("Black", "Pearl Jam", 12, 77, "http://pc/api/cover?name=aaaa.jpg"), w.topTrack)
        assertEquals(listOf(77L, 0L), w.topAlbums.map { it.albumId })
        assertEquals("https://x/pm.jpg", w.topAlbums[1].cover)
        assertEquals(null, w.topArtists[0].cover)
        assertEquals("Grunge", w.topGenre)
        assertEquals(Wrap.Ranked("Ten", "Pearl Jam", 0, 77, "http://pc/api/cover?name=aaaa.jpg"), w.topGenreAlbum)
        assertEquals(3_600_000L, w.months[2])
        assertEquals(3_600_500L, w.months[9])
        assertEquals(LocalDate.of(2026, 3, 14) to 1_800_000L, w.biggestDay)
        assertEquals(3 to 3_600_000L, w.biggestMonth)
    }

    @Test fun playsHiveHasntCountedYetAddOnTopOfItsWrap() {
        val pc = Wrap.fromPc(HiveLinkClient().parseWrap(json), emptyList()) { null }
        fun at(day: String) = LocalDate.parse(day).atTime(12, 0).atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
        fun play(id: Long, title: String, artist: String, album: String, day: String, ms: Long) =
            com.local.hive.mobile.data.PlayRow(id, at(day), ms, title, artist, album, "", id, "")
        val w = pc + listOf(
            play(1, "Black", "Pearl Jam", "Ten", "2026-10-02", 60_000),
            play(2, "Pink Moon", "Nick Drake", "Pink Moon", "2026-10-02", 120_000),
        )
        assertEquals(42, w.plays)
        assertEquals(7_200_500L + 180_000L, w.listenedMs)
        assertEquals(13, w.topTrack?.plays)
        assertEquals(13, w.topArtists.first { it.name == "Pearl Jam" }.plays)
        assertEquals(1, w.topArtists.first { it.name == "Nick Drake" }.plays)
        assertEquals(4, w.topAlbums.first { it.name == "Pink Moon" }.plays)
        assertEquals(3_600_500L + 180_000L, w.months[9])
        assertEquals(w, w + emptyList())
    }

    @Test fun theTopGenresPictureIsItsMostListenedAlbum() {
        fun play(id: Long, album: Long, genre: String, ms: Long) =
            com.local.hive.mobile.data.PlayRow(id, 1_780_000_000_000L + id, ms, "Song $id", "Artist", "Album $album", "", album, genre)
        // Rock is the top genre; within it, album 2 was listened to longest though album 1 was played more often.
        val rows = listOf(play(1, 1, "Rock", 60_000), play(2, 1, "Rock", 60_000), play(3, 2, "Rock", 900_000), play(4, 3, "Jazz", 999_000))
        val w = Wrap.from(2026, rows)
        assertEquals("Rock", w.topGenre)
        assertEquals(2L, w.topGenreAlbum?.albumId)
        assertEquals("Album 2", w.topGenreAlbum?.name)
    }
}
