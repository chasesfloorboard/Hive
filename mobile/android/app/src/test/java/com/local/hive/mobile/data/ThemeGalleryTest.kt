package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ThemeGalleryTest {
    private val assets = File("src/main/assets")
    init { ThemeGallery.loadBlocked(File(assets, "theme-blocked-words.json").readText()) }

    @Test fun theGalleryShippedWithTheAppIsTheRepositorysAndEveryThemePasses() {
        val shipped = File(assets, "theme-gallery.json").readText()
        assertEquals("the phone's copy matches themes/store.json", File("../../../themes/store.json").readText(), shipped)
        assertEquals(File("../../../themes/blocked-words.json").readText(), File(assets, "theme-blocked-words.json").readText())
        val themes = ThemeGallery.parse(shipped)
        assertTrue(themes.size >= 6)
        assertTrue(themes.all { it.css.startsWith(":root {") && "--accent" in it.css })
    }

    @Test fun onlyColoursAndSizesComeThroughNeverUrlsOrOtherCss() {
        val t = ThemeGallery.parse("""{"themes":[{"id":"x","name":"X","vars":{"--bg":"#000","--text":"rgba(255,255,255,1)","--accent":"#f00","--panel":"url(https://t.example/p.png)","--border":"red;}body{display:none","--radius":"9999px"}}]}""").single()
        assertEquals(setOf("--bg", "--text", "--accent"), t.vars.keys)
        assertFalse("url" in t.css || "display" in t.css)
    }

    @Test fun sharedNamesAreFilteredLikeOnThePc() {
        for (bad in listOf("Fuck Yeah", "sh1t theme", "f.u.c.k", "FUUUCK", "Ass", "R3tard")) assertTrue(bad, ThemeGallery.isOffensive(bad))
        for (ok in listOf("Night", "Midnight", "Knight", "Grape", "Therapist", "Raccoon", "Spice", "Torpedo", "Classic", "Scunthorpe Sunset", "Assassin Red", "Cocktail Hour", "Dusk", "Peacock Blue", "Shiitake", "Van Dyke Brown", "Swanky", "Essex")) assertFalse(ok, ThemeGallery.isOffensive(ok))
        assertNull(ThemeGallery.clean(kotlinx.serialization.json.Json.parseToJsonElement("""{"id":"x","name":"Fucking Blue","vars":{"--bg":"#000","--text":"#fff","--accent":"#f00"}}""") as kotlinx.serialization.json.JsonObject))
        val vars = ThemeGallery.varsFromCss(":root {\n  --bg: #5a0f1e;\n  --text: #f7ecee;\n  --accent: #f2d3c4;\n}")!!
        assertTrue(ThemeGallery.shareUrl("Red Velvet", vars).startsWith(ThemeGallery.SHARE_URL + "?labels=theme&title=Theme%3A%20Red%20Velvet"))
        assertTrue(runCatching { ThemeGallery.shareUrl("Bitch Black", vars) }.isFailure)
    }
}
