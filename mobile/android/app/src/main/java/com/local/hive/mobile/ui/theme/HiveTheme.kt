package com.local.hive.mobile.ui.theme

import android.content.Context
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Hive's theme variables (the same `--bg`, `--accent`, `--panel`… a
 * `.hive-theme` or custom-theme.css sets on the desktop), as Compose colors.
 */
@Immutable
data class HiveColors(
    val bg: Color,
    val panel: Color,
    val panelStrong: Color,
    val border: Color,
    val text: Color,
    val textDim: Color,
    val textDimmer: Color,
    val accent: Color,
    val accentSoft: Color,
    val accentGlow: Color,
    val ambientA: Color,
    val ambientB: Color,
    val radius: Dp,
    val blur: Dp,
) {
    companion object {
        /** Hive's built-in look (app/renderer/styles.css :root). */
        val Default = HiveColors(
            bg = Color(0xFF0A0A0D),
            panel = Color(22, 22, 28, (0.55f * 255).roundToInt()),
            panelStrong = Color(18, 18, 24, (0.72f * 255).roundToInt()),
            border = Color(255, 255, 255, (0.08f * 255).roundToInt()),
            text = Color(0xFFECE9F2),
            textDim = Color(0xFF9A97A8),
            textDimmer = Color(0xFF6F6C7C),
            accent = hsl(220f, 0.06f, 0.62f, 1f),
            accentSoft = hsl(220f, 0.06f, 0.72f, 0.38f),
            accentGlow = hsl(220f, 0.06f, 0.55f, 0.28f),
            ambientA = hsl(220f, 0.05f, 0.28f, 0.22f),
            ambientB = hsl(220f, 0.05f, 0.22f, 0.18f),
            radius = 16.dp,
            blur = 28.dp,
        )

        /** Applies the `:root` variables in [css] over [base]; unknown or unparsable values keep the base. */
        fun fromCss(css: String, base: HiveColors = Default): HiveColors {
            val vars = ThemeCss.rootVariables(css)
            fun c(name: String, fallback: Color) = vars[name]?.let { ThemeCss.parseColor(it, vars) } ?: fallback
            fun d(name: String, fallback: Dp) = vars[name]?.let { ThemeCss.parsePx(it) }?.dp ?: fallback
            return HiveColors(
                bg = c("bg", base.bg),
                panel = c("panel", base.panel),
                panelStrong = c("panel-strong", base.panelStrong),
                border = c("border", base.border),
                text = c("text", base.text),
                textDim = c("text-dim", base.textDim),
                textDimmer = c("text-dimmer", base.textDimmer),
                accent = c("accent", base.accent),
                accentSoft = c("accent-soft", base.accentSoft),
                accentGlow = c("accent-glow", base.accentGlow),
                ambientA = c("ambient-a", base.ambientA),
                ambientB = c("ambient-b", base.ambientB),
                radius = d("radius", base.radius),
                blur = d("blur", base.blur),
            )
        }
    }

    /** Hive's --control-bg: 5% accent into the strong panel, here composited over the background. */
    val control: Color get() = mix(accent, mix(panelStrong.copy(alpha = 1f), bg, panelStrong.alpha), 0.05f)
}

internal fun hsl(h: Float, s: Float, l: Float, a: Float): Color {
    val c = (1 - abs(2 * l - 1)) * s
    val hp = ((h % 360) + 360) % 360 / 60f
    val x = c * (1 - abs(hp % 2 - 1))
    val (r1, g1, b1) = when {
        hp < 1 -> Triple(c, x, 0f)
        hp < 2 -> Triple(x, c, 0f)
        hp < 3 -> Triple(0f, c, x)
        hp < 4 -> Triple(0f, x, c)
        hp < 5 -> Triple(x, 0f, c)
        else -> Triple(c, 0f, x)
    }
    val m = l - c / 2
    return Color(r1 + m, g1 + m, b1 + m, a)
}

/** Just enough CSS to read Hive theme variables. */
object ThemeCss {
    fun rootVariables(css: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        val withoutComments = css.replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), "")
        Regex(""":root\s*\{([^}]*)\}""").findAll(withoutComments).forEach { block ->
            Regex("""--([A-Za-z0-9-]+)\s*:\s*([^;]+);?""").findAll(block.groupValues[1]).forEach {
                out[it.groupValues[1]] = it.groupValues[2].trim().removeSuffix("!important").trim()
            }
        }
        return out
    }

    fun parsePx(value: String): Float? = Regex("""^(-?[0-9.]+)(px)?$""").find(value.trim())?.groupValues?.get(1)?.toFloatOrNull()

    fun parseColor(raw: String, vars: Map<String, String> = emptyMap(), depth: Int = 0): Color? {
        val v = raw.trim().lowercase()
        if (depth > 4) return null
        Regex("""^var\(--([a-z0-9-]+)\s*(?:,\s*(.+))?\)$""").find(v)?.let { m ->
            val ref = vars[m.groupValues[1]] ?: m.groupValues[2].ifBlank { null } ?: return null
            return parseColor(ref, vars, depth + 1)
        }
        if (v.startsWith("#")) return hex(v.drop(1))
        Regex("""^(rgba?|hsla?)\((.*)\)$""").find(v)?.let { m ->
            val parts = m.groupValues[2].split(Regex("""[\s,/]+""")).filter { it.isNotBlank() }
            if (parts.size < 3) return null
            fun alpha() = parts.getOrNull(3)?.let { p -> if (p.endsWith("%")) p.dropLast(1).toFloat() / 100f else p.toFloat() } ?: 1f
            return runCatching {
                if (m.groupValues[1].startsWith("rgb")) {
                    fun ch(p: String) = if (p.endsWith("%")) p.dropLast(1).toFloat() * 2.55f else p.toFloat()
                    Color(ch(parts[0]) / 255f, ch(parts[1]) / 255f, ch(parts[2]) / 255f, alpha())
                } else {
                    hsl(parts[0].removeSuffix("deg").toFloat(), parts[1].removeSuffix("%").toFloat() / 100f, parts[2].removeSuffix("%").toFloat() / 100f, alpha())
                }
            }.getOrNull()
        }
        return NAMED[v]
    }

    private fun hex(h: String): Color? {
        val full = when (h.length) {
            3, 4 -> h.map { "$it$it" }.joinToString("")
            6, 8 -> h
            else -> return null
        }
        val n = full.toLongOrNull(16) ?: return null
        return if (full.length == 6) Color(0xFF000000 or n) else Color(((n and 0xFF) shl 24) or (n ushr 8))
    }

    private val NAMED = mapOf("white" to Color.White, "black" to Color.Black, "transparent" to Color.Transparent)
}

/** The active theme: the CSS Hive applies on the PC, bundled or synced. */
class ThemeStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("hive-theme", Context.MODE_PRIVATE)
    private val _colors = MutableStateFlow(load())
    val colors: StateFlow<HiveColors> = _colors.asStateFlow()

    val css: String get() = prefs.getString("css", null) ?: bundledCss()

    fun apply(css: String) {
        prefs.edit { putString("css", css) }
        _colors.value = HiveColors.fromCss(css)
    }

    fun reset() {
        prefs.edit { remove("css") }
        _colors.value = load()
    }

    private fun load() = HiveColors.fromCss(css)
    private fun bundledCss() = runCatching { context.assets.open("default-theme.css").bufferedReader().readText() }.getOrDefault("")
}

val LocalHiveColors = staticCompositionLocalOf { HiveColors.Default }

object Hive {
    val colors: HiveColors @Composable get() = LocalHiveColors.current
}

@Composable
fun HiveTheme(colors: HiveColors, content: @Composable () -> Unit) {
    val scheme = darkColorScheme(
        primary = colors.accent,
        onPrimary = colors.bg,
        secondary = colors.accentSoft,
        background = colors.bg,
        onBackground = colors.text,
        surface = colors.bg,
        onSurface = colors.text,
        surfaceVariant = colors.panelStrong,
        onSurfaceVariant = colors.textDim,
        surfaceContainer = colors.control,
        surfaceContainerHigh = colors.control,
        outline = colors.border,
        outlineVariant = colors.border,
    )
    CompositionLocalProvider(LocalHiveColors provides colors) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
