package com.local.hive.mobile.soulseek

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DriveLinksTest {
    @Test fun readsFolderFileAndOlderLinks() {
        assertEquals(DriveLinks.Link("folder", "1dQ4sx0-__Nvg65rxTSgQrl7VyW_FZ9QI"), DriveLinks.parse("https://drive.google.com/drive/folders/1dQ4sx0-__Nvg65rxTSgQrl7VyW_FZ9QI?usp=sharing"))
        assertEquals(DriveLinks.Link("folder", "1AbCdEfGhIjKlMnOp"), DriveLinks.parse("https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOp"))
        assertEquals(DriveLinks.Link("file", "1eE-5jm2G8N5FL4HH"), DriveLinks.parse("https://drive.google.com/file/d/1eE-5jm2G8N5FL4HH/view"))
        assertEquals(DriveLinks.Link("file", "1eE-5jm2G8N5FL4HH"), DriveLinks.parse("https://drive.google.com/uc?id=1eE-5jm2G8N5FL4HH&export=download"))
        assertEquals("unknown", DriveLinks.parse("https://drive.google.com/open?id=1eE-5jm2G8N5FL4HH")?.kind)
        assertNull(DriveLinks.parse("https://example.com/folders"))
        assertNull(DriveLinks.parse("https://example.com/?id=1eE-5jm2G8N5FL4HH"))
    }

    @Test fun readsThePublicFolderPage() {
        fun entry(id: String, href: String, name: String) = """<div class="flip-entry" id="entry-$id" tabindex="0"><div class="flip-entry-info"><a href="$href" target="_blank"><div class="flip-entry-title">$name</div></a></div></div>"""
        val page = DriveLinks.page("<html><head><title>Road Trip &amp; More</title></head><body>" +
            entry("f10", "https://drive.google.com/file/d/f10/view", "10 Ten.mp3") + entry("f2", "https://drive.google.com/file/d/f2/view", "2 Two.flac") +
            entry("d1", "https://drive.google.com/drive/folders/d1", "Disc 2") + entry("img", "https://drive.google.com/file/d/img/view", "cover.jpg") + "</body></html>")
        assertEquals("Road Trip & More", page.title)
        assertEquals(listOf("Disc 2"), page.folders.map { it.name })
        assertEquals(listOf("2 Two.flac", "10 Ten.mp3"), DriveLinks.sorted(page.files).filter { DriveLinks.isAudio(it.name) }.map { it.name })
    }
}
