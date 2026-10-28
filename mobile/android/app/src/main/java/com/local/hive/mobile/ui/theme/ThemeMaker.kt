package com.local.hive.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import kotlin.math.roundToInt

/**
 * Hive Mobile's own themes, each made from two colours, a background and an
 * accent, the way the Custom theme is: text, panels, borders and glows are
 * worked out from them, so every theme reads well. Light backgrounds take
 * near-black text, coloured and dark ones near-white.
 */
object ThemeMaker {
    data class Swatch(val name: String, val bg: Color, val accent: Color)

    /** The phone's theme set: light and bright first, then deep colours, then the one dark theme. */
    val SUITE = listOf(
        Swatch("Light", Color(0xFFF6F7FB), Color(0xFF4F5FD6)),
        Swatch("Melon", Color(0xFFCDEBFF), Color(0xFF5F8A14)),
        Swatch("Sky Blue", Color(0xFF8FCBE6), Color(0xFF1F4E79)),
        Swatch("Lemon", Color(0xFFFFF3A3), Color(0xFFB4530A)),
        Swatch("Sunflower", Color(0xFFFFD23F), Color(0xFF5A2D82)),
        Swatch("Tangerine", Color(0xFFFF9F45), Color(0xFF6A1B4D)),
        Swatch("Coral", Color(0xFFFF8A7A), Color(0xFF1F3A93)),
        Swatch("Bubblegum", Color(0xFFFFC4E1), Color(0xFFC2185B)),
        Swatch("Cherry", Color(0xFFF2A7B4), Color(0xFF5C0A14)),
        Swatch("Mint", Color(0xFFB8F0D4), Color(0xFF0B7A55)),
        Swatch("Lavender", Color(0xFFD9D2FF), Color(0xFF5A3FD1)),
        Swatch("Ocean", Color(0xFF0E4F6E), Color(0xFF6FE3D4)),
        Swatch("Absolute Zero", Color(0xFF0B3D6B), Color(0xFF7FD1FF)),
        Swatch("Ultramarine", Color(0xFF1F2A9C), Color(0xFFFFD166)),
        Swatch("Emerald", Color(0xFF0F5A43), Color(0xFF7CF2A8)),
        Swatch("Grape", Color(0xFF4B1F6F), Color(0xFFFF9DE2)),
        // MusicBee's Pop Pink, as it was: charcoal with a pink accent.
        Swatch("Pop Pink", Color(0xFF323232), Color(0xFFE4597A)),
        Swatch("Dark", Color(0xFF121317), Color(0xFF9FB3FF)),
    )

    fun pack(s: Swatch) = ThemePack(s.name, css(s.bg, s.accent))

    /** A whole Hive theme (its CSS variables) from a background and an accent. */
    fun css(bg: Color, accent: Color): String {
        val light = bg.luminance() > 0.4f
        val ink = if (light) Color(0xFF111114) else Color.White
        fun v(name: String, c: Color) = "  --$name: ${cssColor(c)};\n"
        return ":root {\n" +
            v("bg", bg) +
            v("panel", mix(Color.White, bg, if (light) 0.45f else 0.07f).copy(alpha = 0.72f)) +
            v("panel-strong", mix(Color.White, bg, if (light) 0.62f else 0.05f).copy(alpha = 0.9f)) +
            v("border", ink.copy(alpha = if (light) 0.14f else 0.12f)) +
            v("text", mix(bg, ink, 0.08f)) +
            v("text-dim", mix(bg, ink, 0.3f)) +
            v("text-dimmer", mix(bg, ink, 0.48f)) +
            v("accent", accent) +
            v("accent-soft", accent.copy(alpha = 0.32f)) +
            v("accent-glow", accent.copy(alpha = if (light) 0.16f else 0.24f)) +
            v("ambient-a", accent.copy(alpha = if (light) 0.10f else 0.20f)) +
            v("ambient-b", mix(accent, bg, 0.5f).copy(alpha = 0.16f)) +
            "  --radius: 14px;\n  --blur: 24px;\n}\n"
    }

    private fun cssColor(c: Color): String {
        fun ch(x: Float) = (x * 255).roundToInt().coerceIn(0, 255)
        return if (c.alpha >= 0.999f) "#%02x%02x%02x".format(ch(c.red), ch(c.green), ch(c.blue))
        else "rgba(${ch(c.red)},${ch(c.green)},${ch(c.blue)},${"%.2f".format(java.util.Locale.ROOT, c.alpha)})"
    }
}
