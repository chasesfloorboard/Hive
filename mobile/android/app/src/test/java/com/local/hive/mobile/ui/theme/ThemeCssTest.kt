package com.local.hive.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ThemeCssTest {
    // The custom-theme.css Hive was using when Hive Mobile was started.
    private val css = """
        :root {
          --bg: #090a0d;
          --panel: rgba(19,20,25,.72);
          --text: #f0eff3;
          --accent: #b9bac2;
          --accent-soft: rgba(205,207,220,.35);
          --radius: 14px;
        }
    """.trimIndent()

    private fun near(expected: Color, actual: Color) {
        listOf(expected.red to actual.red, expected.green to actual.green, expected.blue to actual.blue, expected.alpha to actual.alpha)
            .forEach { (e, a) -> assertEquals(e, a, 0.01f) }
    }

    @Test fun readsHiveThemeVariables() {
        val colors = HiveColors.fromCss(css)
        near(Color(0xFF090A0D), colors.bg)
        near(Color(19, 20, 25, (0.72f * 255).toInt()), colors.panel)
        near(Color(0xFFB9BAC2), colors.accent)
        assertEquals(14.dp, colors.radius)
        // Not set by this theme: Hive's default stays.
        near(HiveColors.Default.textDimmer, colors.textDimmer)
    }

    @Test fun parsesHslAndVarReferences() {
        near(hsl(220f, 0.06f, 0.62f, 1f), ThemeCss.parseColor("hsla(220, 6%, 62%, 1)")!!)
        near(Color(0xFF7DD3FC), ThemeCss.parseColor("var(--accent)", mapOf("accent" to "#7dd3fc"))!!)
        near(Color(0x80FFFFFF), ThemeCss.parseColor("#ffffff80")!!)
        near(Color(0xFFFFFFFF), ThemeCss.parseColor("#fff")!!)
    }

    @Test fun ignoresWhatItCannotRead() {
        assertNull(ThemeCss.parseColor("color-mix(in srgb, var(--accent) 5%, black)"))
        assertEquals(HiveColors.Default.bg, HiveColors.fromCss(":root { --bg: nonsense; }").bg)
    }
}
