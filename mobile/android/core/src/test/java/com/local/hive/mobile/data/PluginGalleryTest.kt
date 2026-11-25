package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PluginGalleryTest {
    @Before
    fun loadWords() {
        ThemeGallery.loadBlocked("""{"anywhere":["fuck","shit"],"words":["ass"]}""")
    }

    @Test
    fun parsesCatalogAndEnforcesTierVerificationAndPermissionWhitelist() {
        val raw = """
            {
              "version": 1,
              "plugins": [
                {
                  "id": "Community.Clock!",
                  "name": "Studio <b>Clock</b>",
                  "version": "1.0.0",
                  "author": "Alex",
                  "description": "Nice clock",
                  "icon": "<svg></svg>",
                  "apiVersion": 2,
                  "verified": true,
                  "builtin": true,
                  "platforms": ["desktop", "mobile", "toaster"],
                  "permissions": ["player.read", "fs.write", "ui.view"],
                  "js": "return (function(){})();",
                  "css": ".a{color:red}"
                },
                {
                  "id": "../escape",
                  "name": "Bad Path",
                  "apiVersion": 2,
                  "js": "1"
                },
                {
                  "id": "bad.words",
                  "name": "Fucking Loud",
                  "apiVersion": 2,
                  "js": "1"
                }
              ]
            }
        """.trimIndent()

        val community = PluginGallery.parse(raw, verified = false)
        assertEquals(1, community.size)
        val p = community.first()
        assertEquals("community.clock-", p.id)
        assertEquals("Studio bClock/b", p.name)
        assertEquals("◈", p.icon)
        assertFalse("community catalog never trusts verified:true", p.verified)
        assertFalse("community catalog never trusts builtin:true", p.builtin)
        assertEquals(listOf("desktop", "mobile"), p.platforms)
        assertEquals(listOf("player.read", "ui.view"), p.permissions)

        val verified = PluginGallery.parse(raw, verified = true)
        assertEquals(1, verified.size)
        assertTrue(verified.first().verified)
        assertTrue(verified.first().builtin)
    }

    @Test
    fun submitUrlTargetsVerifiedOrCommunityAndBlocksOffensiveNames() {
        val (verifiedUrl, payload) = PluginGallery.submitUrl(
            id = "user.bars", name = "Neon Bars", author = "Dev", description = "Bars",
            permissions = listOf("player.read", "spectrum.read", "bad.perm"),
            js = "console.log(1);", css = "", target = "verified",
        )
        assertTrue(verifiedUrl.contains("labels=plugin&"))
        assertTrue(verifiedUrl.contains("Review"))
        assertTrue(payload.contains("\"spectrum.read\""))
        assertFalse(payload.contains("bad.perm"))

        val (commUrl, _) = PluginGallery.submitUrl(
            id = "user.bars", name = "Neon Bars", author = "Dev", description = "Bars",
            permissions = listOf("player.read"), js = "1;", css = "", target = "community",
        )
        assertTrue(commUrl.contains("labels=plugin-community&"))
        assertTrue(commUrl.contains("Untested"))

        val bad = runCatching {
            PluginGallery.submitUrl("a.b", "Shit Plugin", "x", "", emptyList(), "1;", "", "community")
        }.exceptionOrNull()
        assertNotNull(bad)
    }

    @Test
    fun rejectsEmptyJsForNonBuiltinPlugin() {
        val raw = """{"plugins":[{"id":"empty.js","name":"Empty","apiVersion":2,"js":"   "}]}"""
        assertTrue(PluginGallery.parse(raw, verified = false).isEmpty())
    }
}
