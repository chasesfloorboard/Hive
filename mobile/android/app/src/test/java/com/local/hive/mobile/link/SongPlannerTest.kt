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
