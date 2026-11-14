package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class CoverEditTest {
    private fun pic(name: String, type: Int) = EmbeddedPictures.Picture(name.toByteArray(), type)
    private fun shown(list: List<Pair<ByteArray, Int>>) = list.map { (b, t) -> String(b) + if (t == EmbeddedPictures.BACK) " (back)" else if (t == EmbeddedPictures.FRONT) " (front)" else " ($t)" }

    private val album = listOf(pic("colour", 3), pic("mono", 4))
    private val single = listOf(pic("colour", 3), pic("mono", 4), pic("single", 4), pic("booklet", 0))

    @Test fun anAlbumsBackCoverReplacesEachSongsFirstBackCoverOnly() {
        val edit = CoverEdit(backs = mapOf(0 to "new mono".toByteArray()))
        assertEquals(listOf("colour (front)", "new mono (back)"), shown(edit.applyTo(album)))
        assertEquals(listOf("colour (front)", "new mono (back)", "single (back)", "booklet (0)"), shown(edit.applyTo(single)))
    }

    @Test fun aSongWithoutABackCoverGetsOneAdded() =
        assertEquals(listOf("colour (front)", "mono (back)"), shown(CoverEdit(backs = mapOf(0 to "mono".toByteArray())).applyTo(listOf(pic("colour", 3)))))

    @Test fun aThirdBackCoverIsAddedAfterTheOthers() =
        assertEquals(listOf("colour (front)", "mono (back)", "single (back)"), shown(CoverEdit(backs = mapOf(5 to "single".toByteArray())).applyTo(album)))

    @Test fun aBackCoverCanBeTakenOff() =
        assertEquals(listOf("colour (front)", "single (back)", "booklet (0)"), shown(CoverEdit(backs = mapOf(0 to null)).applyTo(single)))

    @Test fun aNewFrontCoverKeepsTheBackCovers() {
        assertEquals(listOf("new (front)", "mono (back)"), shown(CoverEdit(front = "new".toByteArray()).applyTo(album)))
        assertEquals(listOf("new (front)"), shown(CoverEdit(front = "new".toByteArray()).applyTo(emptyList())))
    }
}
