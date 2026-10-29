package com.local.hive.mobile.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MirrorPlannerTest {
    private fun f(size: Long, modified: Long) = FileStat(size, modified)
    private fun plan(phone: Map<String, FileStat>, pc: Map<String, FileStat>, ledger: Map<String, Agreed> = emptyMap(), left: Set<String> = emptySet()) =
        MirrorPlanner.plan(phone, pc, ledger, left)

    @Test fun meetingFirstTheSameSizeIsTakenAsTheSameFile() {
        val p = plan(mapOf("A/song.mp3" to f(100, 5)), mapOf("A/song.mp3" to f(100, 9)))
        assertTrue(p.toPhone.isEmpty() && p.toPc.isEmpty())
        assertEquals(Agreed(f(100, 5), f(100, 9)), p.agreed["A/song.mp3"])
    }

    @Test fun meetingFirstDifferentTheNewerWinsAndALosingPhoneCopyIsKept() {
        val pcNewer = plan(mapOf("s.mp3" to f(100, 5)), mapOf("s.mp3" to f(120, 9)))
        assertEquals(listOf("s.mp3"), pcNewer.toPhone)
        assertTrue("s.mp3" in pcNewer.keepPhoneFirst)
        val phoneNewer = plan(mapOf("s.mp3" to f(100, 9)), mapOf("s.mp3" to f(120, 5)))
        assertEquals(listOf("s.mp3"), phoneNewer.toPc)
    }

    @Test fun theSideThatChangedSinceTheyAgreedIsCopiedEvenAtTheSameSize() {
        val was = mapOf("s.mp3" to Agreed(f(100, 5_000), f(100, 5_000)))
        // A play count going from 1 to 2 changes no size: the modified time tells.
        val pcChanged = plan(mapOf("s.mp3" to f(100, 5_000)), mapOf("s.mp3" to f(100, 80_000)), was)
        assertEquals(listOf("s.mp3"), pcChanged.toPhone)
        assertTrue(pcChanged.keepPhoneFirst.isEmpty())
        val phoneChanged = plan(mapOf("s.mp3" to f(130, 80_000)), mapOf("s.mp3" to f(100, 5_000)), was)
        assertEquals(listOf("s.mp3"), phoneChanged.toPc)
        val neither = plan(mapOf("s.mp3" to f(100, 5_000)), mapOf("s.mp3" to f(100, 5_000)), was)
        assertTrue(neither.toPhone.isEmpty() && neither.toPc.isEmpty())
    }

    @Test fun bothChangedTheNewerWins() {
        val was = mapOf("s.mp3" to Agreed(f(100, 5), f(100, 5)))
        val p = plan(mapOf("s.mp3" to f(110, 20)), mapOf("s.mp3" to f(120, 10)), was)
        assertEquals(listOf("s.mp3"), p.toPc)
        val q = plan(mapOf("s.mp3" to f(110, 10)), mapOf("s.mp3" to f(120, 20)), was)
        assertEquals(listOf("s.mp3"), q.toPhone)
        assertTrue("s.mp3" in q.keepPhoneFirst)
    }

    @Test fun newFilesAreCopiedButFilesGoneFromOneSideAreOnlyAskedAbout() {
        val was = mapOf("old.mp3" to Agreed(f(1, 1), f(1, 1)), "gone.mp3" to Agreed(f(2, 2), f(2, 2)))
        val p = plan(
            phone = mapOf("new on phone.flac" to f(3, 3), "gone.mp3" to f(2, 2)),
            pc = mapOf("new on pc.txt" to f(4, 4), "old.mp3" to f(1, 1)),
            ledger = was,
        )
        assertEquals(listOf("new on pc.txt"), p.toPhone)
        assertEquals(listOf("new on phone.flac"), p.toPc)
        assertEquals(listOf("old.mp3"), p.goneFromPhone)
        assertEquals(listOf("gone.mp3"), p.goneFromPc)
        assertEquals(3L, p.bytesToPc)
        assertEquals(4L, p.bytesToPhone)
    }

    @Test fun filesTheUserLeftOnOneSideStayThere() {
        val p = plan(mapOf("Kept/x.mp3" to f(1, 1)), emptyMap(), mapOf("kept/X.mp3" to Agreed(f(1, 1), f(1, 1))), left = setOf("kept/x.mp3"))
        assertTrue(p.goneFromPc.isEmpty() && p.toPc.isEmpty())
    }

    @Test fun letterCaseDoesNotMakeTwoFiles() {
        val p = plan(mapOf("artist/song.mp3" to f(100, 1)), mapOf("Artist/Song.mp3" to f(100, 2)))
        assertTrue(p.toPhone.isEmpty() && p.toPc.isEmpty())
        assertEquals(setOf("Artist/Song.mp3"), p.agreed.keys)
    }

    @Test fun songsNamedWithALeadingDotAreUnhiddenOnThePhoneOnly() {
        assertEquals("A/_..And So It Was.mp3", MirrorPlanner.phonePath("A/...And So It Was.mp3"))
        assertEquals("_Exe.mp3", MirrorPlanner.phonePath(".Exe.mp3"))
        // Not songs: Android's own marker files keep their names.
        assertEquals("Soulseek/.nomedia", MirrorPlanner.phonePath("Soulseek/.nomedia"))
        val pcKeys = setOf("a/...and so it was.mp3", ".exe.mp3", "_.mp3", ". . . ..mp3")
        assertEquals("A/...And So It Was.mp3", MirrorPlanner.pcPath("A/_..And So It Was.mp3", pcKeys))
        assertEquals(".Exe.mp3", MirrorPlanner.pcPath("_Exe.mp3", pcKeys))
        assertEquals(". . . ..mp3", MirrorPlanner.pcPath("_ . . ..mp3", pcKeys))
        // A song really called "_.mp3" is itself, and "_notes.txt" isn't a song.
        assertEquals("_.mp3", MirrorPlanner.pcPath("_.mp3", pcKeys))
        assertEquals("_notes.txt", MirrorPlanner.pcPath("_notes.txt", pcKeys))
        val p = plan(mapOf("_Exe.mp3" to f(5, 1), "_.mp3" to f(6, 1)), mapOf(".Exe.mp3" to f(5, 1), "_.mp3" to f(6, 1)))
        assertTrue(p.toPhone.isEmpty() && p.toPc.isEmpty())
        assertEquals(setOf(".Exe.mp3", "_.mp3"), p.agreed.keys)
    }

    @Test fun anSdCardRoundingTheTimeIsNoChange() {
        // The PC said 21:03:06.870; the card keeps 21:03:06.000.
        val was = mapOf("s.mp3" to Agreed(f(100, 1_793_246_586_870), f(100, 1_793_246_586_870)))
        val p = plan(mapOf("s.mp3" to f(100, 1_793_246_586_000)), mapOf("s.mp3" to f(100, 1_793_246_586_870)), was)
        assertTrue(p.toPhone.isEmpty() && p.toPc.isEmpty())
    }
}
