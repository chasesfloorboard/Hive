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
         "topGenres":[{"name":"Grunge","seconds":3000}],
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
        assertEquals(3_600_000L, w.months[2])
        assertEquals(3_600_500L, w.months[9])
        assertEquals(LocalDate.of(2026, 3, 14) to 1_800_000L, w.biggestDay)
        assertEquals(3 to 3_600_000L, w.biggestMonth)
    }
}
