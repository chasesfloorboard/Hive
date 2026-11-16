package com.local.hive.mobile.soulseek

import com.local.hive.mobile.data.TrackMatcher
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [sameAlbumCopy] decides whether a track already in the library counts as "already have" for an album
 * download, so it is skipped. The rule the user set: only a copy ON THE SAME ALBUM blocks the download. A
 * copy of the song from a DIFFERENT release (e.g. HAD ENOUGH on JACKBOYS while downloading Don Toliver's
 * Heaven or Hell) must NOT block it -- every album keeps its own copy of every track, at that album's quality.
 */
class SoulseekDedupTest {
    private val donToliver = TrackMatcher.artistParts("Don Toliver")

    @Test fun `a copy on a DIFFERENT album does not block the album's own copy`() {
        // Downloading Heaven or Hell; HAD ENOUGH is in the library but filed under JACKBOYS -> still download it.
        assertFalse(
            sameAlbumCopy("Heaven or Hell", donToliver, 157_000L, "JACKBOYS", "Don Toliver, Quavo, Offset", "JACKBOYS", 157_000L),
        )
    }

    @Test fun `a copy on the SAME album counts, so it is not re-downloaded`() {
        assertTrue(
            sameAlbumCopy("Heaven or Hell", donToliver, 157_000L, "Heaven or Hell", "Don Toliver", "Don Toliver", 157_000L),
        )
    }

    @Test fun `the same album but a different artist does not count`() {
        assertFalse(
            sameAlbumCopy("Heaven or Hell", donToliver, 157_000L, "Heaven or Hell", "Someone Else", "Someone Else", 157_000L),
        )
    }

    @Test fun `the same album but a clearly different length does not count`() {
        assertFalse(
            sameAlbumCopy("Heaven or Hell", donToliver, 157_000L, "Heaven or Hell", "Don Toliver", "Don Toliver", 230_000L),
        )
    }

    @Test fun `album case and spacing are ignored, and an unknown request length still matches`() {
        assertTrue(
            sameAlbumCopy("Heaven or Hell", donToliver, 0L, "Heaven Or Hell", "Don Toliver", "Don Toliver", 999_000L),
        )
    }
}
