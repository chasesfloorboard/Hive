package com.local.hive.mobile.data

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AtomicFileTest {
    private fun tempDir() = File(System.getProperty("java.io.tmpdir"), "hive-atomic-${System.nanoTime()}").apply { mkdirs() }

    @Test fun `writes content and leaves no temp file behind`() {
        val dir = tempDir()
        try {
            val f = File(dir, "store.json")
            f.writeTextAtomic("""{"a":1}""")
            assertEquals("""{"a":1}""", f.readText())
            assertFalse("the .tmp sibling must be gone after an atomic write", File(dir, "store.json.tmp").exists())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `overwrites an existing file in place`() {
        val dir = tempDir()
        try {
            val f = File(dir, "store.json")
            f.writeTextAtomic("old")
            f.writeTextAtomic("new value")
            assertEquals("new value", f.readText())
            assertFalse(File(dir, "store.json.tmp").exists())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `a crash that leaves only the temp file never corrupts the live file`() {
        // Simulate a kill mid-write: the temp exists, the live file is the previous good copy. An atomic
        // write must never expose the temp as the live file, and a fresh write must still succeed.
        val dir = tempDir()
        try {
            val f = File(dir, "store.json")
            f.writeTextAtomic("good")
            File(dir, "store.json.tmp").writeText("half-written {") // stray temp from a crashed write
            assertEquals("the live file is untouched by a leftover temp", "good", f.readText())
            f.writeTextAtomic("good2")
            assertEquals("good2", f.readText())
            assertFalse(File(dir, "store.json.tmp").exists())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `runCatchingNotCancelled catches ordinary failures but rethrows cancellation`() {
        assertEquals(5, runCatchingNotCancelled { 5 }.getOrDefault(0))
        assertEquals(emptyList<String>(), runCatchingNotCancelled { throw java.io.IOException("offline"); listOf("x") }.getOrDefault(emptyList()))
        assertNull(runCatchingNotCancelled { throw RuntimeException("boom") }.getOrNull())
        var rethrew = false
        try { runCatchingNotCancelled { throw CancellationException("left the screen") } } catch (c: CancellationException) { rethrew = true }
        assertTrue("CancellationException must propagate, not be swallowed", rethrew)
    }
}
