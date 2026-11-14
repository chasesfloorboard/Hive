package com.local.hive.mobile.link

import com.local.hive.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SongPlannerTest {
    private fun phone(id: Long, title: String, artist: String, durationMs: Long = 200_000, album: String = "A") =
        Track(id, title, artist, album, "", 1, durationMs, 1, 1, 2020, "", "Music", "$title.m4a", 0, 4_000_000)

    private fun pc(id: String, title: String, artist: String, durationMs: Long = 200_000) =
        PcTrack(id = id, title = title, artist = artist, album = "A", duration = durationMs, file = "$title.mp3", size = 8_000_000)

    @Test fun songsOnOneSideOnlyAreCopiedToTheOther() {
        val plan = SongPlanner.plan(
            phone = listOf(phone(1, "Black", "Pearl Jam"), phone(2, "Phone Only", "Someone")),
            pc = listOf(pc("a", "Black", "Pearl Jam"), pc("b", "PC Only", "Someone Else")),
            ledger = emptySet(),
        )
        assertEquals(listOf("b"), plan.toPhone.map { it.id })
        assertEquals(listOf(2L), plan.toPc.map { it.id })
        assertEquals(8_000_000, plan.bytesToPhone)
        assertTrue("songs on both sides go in the ledger", plan.phoneKeys.getValue(1L) in plan.onBoth && plan.pcKeys.getValue("a") in plan.onBoth)
    }

    @Test fun aSongDeletedOnOneSideIsNotCopiedBack() {
        // First both sides have both songs: the ledger learns them.
        val first = SongPlanner.plan(
            phone = listOf(phone(1, "Kept On Phone", "Band"), phone(2, "Kept On PC", "Band")),
            pc = listOf(pc("x", "Kept On Phone", "Band"), pc("y", "Kept On PC", "Band")),
            ledger = emptySet(),
        )
        // Then one is deleted on the PC and the other on the phone.
        val plan = SongPlanner.plan(
            phone = listOf(phone(1, "Kept On Phone", "Band")),
            pc = listOf(pc("y", "Kept On PC", "Band")),
            ledger = first.onBoth,
        )
        assertTrue(plan.toPhone.isEmpty())
        assertTrue(plan.toPc.isEmpty())
        // Each is reported for the user to decide: delete on the other side too, copy back, or leave.
        assertEquals(listOf(1L), plan.goneFromPc.map { it.id })
        assertEquals(listOf("y"), plan.goneFromPhone.map { it.id })
    }

    @Test fun theSidesAreKeptOneToOneFileForFile() {
        // The PC keeps a song twice (album and soundtrack versions, 11 s apart); the phone
        // has one. The phone's file pairs with the closer one; the other is copied over.
        val plan = SongPlanner.plan(
            phone = listOf(phone(1, "Low Rider", "WAR", 190_900)),
            pc = listOf(pc("album", "Low Rider", "WAR", 190_900), pc("skate", "Low Rider", "WAR", 179_800)),
            ledger = emptySet(),
        )
        assertEquals(listOf("skate"), plan.toPhone.map { it.id })
        // Two identical copies on the phone and one on the PC: one goes to the PC, saying Hive already holds one.
        val back = SongPlanner.plan(
            phone = listOf(phone(1, "Huge", "Boris", 201_000), phone(2, "Huge", "Boris", 201_000)),
            pc = listOf(pc("mp3", "Huge", "Boris", 201_000)),
            ledger = emptySet(),
        )
        assertEquals(1, back.toPc.size)
        assertEquals(1, back.pcCopies[back.toPc.single().id])
    }

    @Test fun anExactCopyPairsWhateverItsTagsSay() {
        // Android read this copy's damaged tags as the file name with no artist; Hive reads the real ones.
        // Same size to the byte and same length: it's the same file, so nothing is copied either way.
        val phoneCopy = phone(1, "Big Data _ The Internet Ain't Safe", "", 514_328).copy(sizeBytes = 21_308_366)
        val pcFile = pc("x", "Big Data / The Internet Ain't", "JPEGMAFIA x Freaky", 514_273).copy(size = 21_308_366)
        val plan = SongPlanner.plan(phone = listOf(phoneCopy), pc = listOf(pcFile), ledger = emptySet())
        assertTrue(plan.toPhone.isEmpty())
        assertTrue(plan.toPc.isEmpty())
        assertEquals(2, plan.onBoth.size)
    }

    @Test fun theSameFileNameAndLengthPairWhenTagsAndSizeDiffer() {
        // Retagged on the PC since it was copied (so the size differs), and its tags read badly on the phone.
        val phoneCopy = phone(1, "Big Data _ The Internet Ain't Safe", "", 514_328).copy(fileName = "Big Data _ The Internet Ain't Safe.mp3", sizeBytes = 21_300_000)
        val pcFile = pc("x", "Big Data / The Internet Ain't", "JPEGMAFIA x Freaky", 514_273).copy(file = "Big Data _ The Internet Ain't Safe.mp3", size = 21_308_366)
        val plan = SongPlanner.plan(phone = listOf(phoneCopy), pc = listOf(pcFile), ledger = emptySet())
        assertTrue(plan.toPhone.isEmpty() && plan.toPc.isEmpty())
    }

    @Test fun onlyExtraCopiesAndModFilesMayBeDeletedOnTheOtherSide() {
        fun file(id: Long, title: String, artist: String, size: Long, name: String = "$title.mp3") =
            Track(id, title, artist, "A", "", 1, 210_000, 1, 1, 2020, "", "Music", name, 0, size)
        val phoneFiles = listOf(
            file(1, "We're Here", "Meat Puppets", 7_107_491), file(2, "We're Here", "Meat Puppets", 7_107_491, "06 - We're Here.mp3"),
            file(3, "Huge", "Boris", 5_000_000), file(4, "voice_017", "", 90_000, "Elden Ring - Nurse Harrow voice.wav"),
        )
        val pcFiles = listOf(
            PcTrack(id = "orig", title = "We're Here", artist = "Meat Puppets", duration = 210_000, file = "We're Here.mp3", size = 7_107_491),
            PcTrack(id = "dup", title = "We're Here", artist = "Meat Puppets", duration = 210_000, file = "06 - We're Here.mp3", size = 7_107_491),
            PcTrack(id = "huge", title = "Huge", artist = "Boris", duration = 210_000, file = "Huge.mp3", size = 5_000_000),
            PcTrack(id = "mod", title = "voice_017", duration = 210_000, file = "Elden Ring - Nurse Harrow voice.wav", size = 90_000),
        )
        val first = SongPlanner.plan(phoneFiles, pcFiles, emptySet())
        // The PC loses its extra We're Here, its only Huge and the mod file.
        val plan = SongPlanner.plan(phoneFiles, pcFiles.filter { it.id == "orig" }, first.onBoth)
        assertEquals(3, plan.goneFromPc.size)
        val deletable = plan.goneFromPc.filter { plan.phoneKeys.getValue(it.id) in plan.deletable }.map { it.fileName }.toSet()
        assertEquals("the phone's extra copy and the mod file may go; its only Huge never", setOf("06 - We're Here.mp3", "Elden Ring - Nurse Harrow voice.wav"), deletable)
    }

    @Test fun eachCopyOfASongHasItsOwnLedgerEntry() {
        // Both versions synced once; then the phone deletes one of them: only that one stays deleted.
        val first = SongPlanner.plan(
            phone = listOf(phone(1, "Low Rider", "WAR", 190_900), phone(2, "Low Rider", "WAR", 179_800)),
            pc = listOf(pc("album", "Low Rider", "WAR", 190_900), pc("skate", "Low Rider", "WAR", 179_800)),
            ledger = emptySet(),
        )
        assertEquals(4, first.onBoth.size)
        val plan = SongPlanner.plan(
            phone = listOf(phone(1, "Low Rider", "WAR", 190_900)),
            pc = listOf(pc("album", "Low Rider", "WAR", 190_900), pc("skate", "Low Rider", "WAR", 179_800), pc("new", "Low Rider", "WAR", 300_000)),
            ledger = first.onBoth,
        )
        assertEquals("the deleted version isn't copied back, a new one is", listOf("new"), plan.toPhone.map { it.id })
    }

    @Test fun keysIgnoreFormattingButNotTheSong() {
        assertEquals(SongPlanner.keyOf("Together (feat. Nikki Nair)", "The Avalanches", ""), SongPlanner.keyOf("Together", "The Avalanches", ""))
        assertTrue(SongPlanner.keyOf("Black", "Pearl Jam", "") != SongPlanner.keyOf("Black", "Sevdaliza", ""))
    }
}
