package com.local.hive.mobile.soulseek

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [SoulseekWorker.resumable] decides which saved downloads to pick back up after a restart — so an
 * interrupted download resumes on its own and the user never has to go re-find the album.
 */
class ResumeDownloadsTest {
    private fun song(title: String, state: String = "waiting") = DownloadSong(title, state)

    @Test fun `a job that stored its request is resumed in place, no stale entry to retire`() {
        val req = SoulseekRequest("Armand Hammer", "We Buy Diabetic Test Strips",
            listOf(SoulseekRequest.Track("Landlines"), SoulseekRequest.Track("Doves")))
        val job = DownloadJob(req.id, req.artist, req.album, req.label,
            listOf(song("Landlines", "done"), song("Doves")),
            request = Json.encodeToString(SoulseekRequest.serializer(), req))

        val resumable = SoulseekWorker.resumable(listOf(job))

        assertEquals(1, resumable.size)
        val (staleId, out) = resumable[0]
        assertNull("a stored-request job keeps its id, nothing to retire", staleId)
        assertEquals(req.id, out.id)
        assertEquals(listOf("Landlines", "Doves"), out.tracks.map { it.title })
    }

    @Test fun `a legacy job with no stored request is reconstructed and its stale entry retired`() {
        // Pre-vc179: random UUID id, blank request, caught mid-download.
        val job = DownloadJob("8f1c2e9a-random-uuid", "The Microphones", "The Glow Pt. 2", "The Glow Pt. 2 by The Microphones",
            listOf(song("I Want Wind to Blow", "done"), song("The Glow Pt. 2", "downloading"), song("The Moon")),
            state = "downloading", request = "")

        val resumable = SoulseekWorker.resumable(listOf(job))

        assertEquals(1, resumable.size)
        val (staleId, out) = resumable[0]
        assertEquals("the random-id legacy entry must be retired", "8f1c2e9a-random-uuid", staleId)
        assertEquals("album", out.kind)
        assertEquals("The Microphones", out.artist)
        assertEquals("The Glow Pt. 2", out.album)
        assertEquals(listOf("I Want Wind to Blow", "The Glow Pt. 2", "The Moon"), out.tracks.map { it.title })
        // Reconstructed id is the stable one, which differs from the old random id (so enqueue adds fresh).
        assertTrue(out.id.startsWith("slsk:album:"))
    }

    @Test fun `a single-song legacy job reconstructs as a track request`() {
        val job = DownloadJob("rnd", "Burial", "Untrue", "x",
            listOf(song("Archangel", "missing")), state = "failed", request = "")

        val (_, out) = SoulseekWorker.resumable(listOf(job)).single()

        assertEquals("track", out.kind)
        assertEquals(listOf("Archangel"), out.tracks.map { it.title })
    }

    @Test fun `a finished all-done download is not resumed`() {
        val req = SoulseekRequest("Boards of Canada", "Geogaddi", listOf(SoulseekRequest.Track("Music Is Math")))
        val job = DownloadJob(req.id, req.artist, req.album, req.label, listOf(song("Music Is Math", "done")),
            state = "done", request = Json.encodeToString(SoulseekRequest.serializer(), req))

        assertTrue(SoulseekWorker.resumable(listOf(job)).isEmpty())
    }

    @Test fun `a cancelled download is not resumed`() {
        val job = DownloadJob("rnd", "x", "y", "z", listOf(song("a", "missing")),
            state = "failed", cancelled = true, request = "")

        assertTrue(SoulseekWorker.resumable(listOf(job)).isEmpty())
    }

    @Test fun `a corrupt stored request falls back to reconstruction rather than being dropped`() {
        val job = DownloadJob("slsk:album:x:y", "X", "Y", "Y by X",
            listOf(song("One"), song("Two")), state = "downloading", request = "{not valid json")

        val (staleId, out) = SoulseekWorker.resumable(listOf(job)).single()

        assertNull("request wasn't blank, so no legacy retire", staleId)
        assertEquals(listOf("One", "Two"), out.tracks.map { it.title })
    }
}
