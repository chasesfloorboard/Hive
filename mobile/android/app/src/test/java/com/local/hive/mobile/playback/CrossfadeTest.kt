package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class CrossfadeTest {
    @Test fun aLongSongGetsTheChosenLength() = assertEquals(6_000, Crossfader.fit(6_000, 200_000, 180_000))

    @Test fun aShortSongGetsAsMuchAsFits() {
        // A 10 s song with a 6 s crossfade: half the song (less a moment), not nothing.
        assertEquals(4_750, Crossfader.fit(6_000, 10_000, 200_000))
        // A short next song limits it too.
        assertEquals(3_000, Crossfader.fit(6_000, 200_000, 6_000))
        // The next song's length not known yet: only this one counts.
        assertEquals(6_000, Crossfader.fit(6_000, 200_000, 0))
    }

    @Test fun aSongTooShortForAnyFadePlaysStraightOn() {
        assertEquals(0, Crossfader.fit(6_000, 1_200, 200_000))
        assertEquals(0, Crossfader.fit(0, 200_000, 200_000))
    }
}
