package com.local.hive.mobile.ui.theme

import kotlinx.coroutines.launch
import android.content.Context
import androidx.compose.ui.graphics.luminance
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
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
            return readable(HiveColors(
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
            ))
        }

        /**
         * A theme's text made readable on its own background: text at least
         * 4.5:1 (WCAG body text), dim text 3:1, dimmest 2:1, the accent 3:1 (it's
         * used for text and icons too). Colours that already pass are left alone;
         * the others move toward white on dark themes or black on light ones,
         * just far enough. (MusicBee skins especially set text near their background.)
         */
        fun readable(t: HiveColors): HiveColors = t.copy(
            text = contrasted(t.text, t.bg, 4.5f),
            textDim = contrasted(t.textDim, t.bg, 3f),
            textDimmer = contrasted(t.textDimmer, t.bg, 2f),
            accent = contrasted(t.accent, t.bg, 3f),
        )

        fun contrast(a: Color, b: Color): Float {
            val la = a.luminance(); val lb = b.luminance()
            return (maxOf(la, lb) + 0.05f) / (minOf(la, lb) + 0.05f)
        }

        fun contrasted(fg: Color, bg: Color, min: Float): Color {
            val solid = fg.copy(alpha = 1f)
            if (contrast(solid, bg) >= min) return fg
            val toward = if (bg.luminance() > 0.4f) Color.Black else Color.White
            var step = 0.05f
            while (step <= 1f) {
                val c = androidx.compose.ui.graphics.lerp(solid, toward, step)
                if (contrast(c, bg) >= min) return c.copy(alpha = fg.alpha.coerceAtLeast(0.9f))
                step += 0.05f
            }
            return toward
        }
    }

    /** Hive's --control-bg: 5% accent into the strong panel, here composited over the background. */
    val control: Color get() = mix(accent, mix(panelStrong.copy(alpha = 1f), bg, panelStrong.alpha), 0.05f)
}

/** A colour as hue (0-360), saturation and lightness (0-1), as [hsl] takes them. */
fun toHsl(c: Color): Triple<Float, Float, Float> {
    val max = maxOf(c.red, c.green, c.blue); val min = minOf(c.red, c.green, c.blue)
    val l = (max + min) / 2f
    if (max == min) return Triple(0f, 0f, l)
    val d = max - min
    val s = if (l > 0.5f) d / (2f - max - min) else d / (max + min)
    val h = when (max) {
        c.red -> ((c.green - c.blue) / d + if (c.green < c.blue) 6f else 0f)
        c.green -> (c.blue - c.red) / d + 2f
        else -> (c.red - c.green) / d + 4f
    } * 60f
    return Triple(h, s, l)
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

/** A theme as Hive packs it: a name and its CSS variables. */
data class ThemePack(val name: String, val css: String) {
    val colors: HiveColors get() = HiveColors.fromCss(css)

    companion object {
        /** A .hive-theme file ({"format":"hive-theme","name":…,"css":…}) or plain CSS. */
        fun parse(text: String, fallbackName: String): ThemePack? {
            val trimmed = text.trim()
            if (trimmed.startsWith("{")) {
                val o = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(trimmed) as kotlinx.serialization.json.JsonObject }.getOrNull() ?: return null
                fun str(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content
                val css = str("css") ?: return null
                return ThemePack(str("name") ?: fallbackName, css)
            }
            return if (trimmed.contains("--")) ThemePack(fallbackName, trimmed) else null
        }
    }
}

/** The active theme: the CSS Hive applies on the PC, bundled or synced. */
class ThemeStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("hive-theme", Context.MODE_PRIVATE)
    private val _colors = MutableStateFlow(load())
    val colors: StateFlow<HiveColors> = _colors.asStateFlow()
    private val _name = MutableStateFlow(prefs.getString("name", null) ?: YOUR_THEME)
    val name: StateFlow<String> = _name.asStateFlow()

    val css: String get() = prefs.getString("css", null) ?: yourHiveCss()

    /** The theme Hive on the PC shows (as last synced), else Hive's default. */
    private fun yourHiveCss() = prefs.getString("pc.current", null) ?: bundledCss()

    private val pcFile = java.io.File(context.filesDir, "pc-themes.json")
    private val themeJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
    private fun loadPc(): List<com.local.hive.mobile.link.PcTheme> = runCatching {
        themeJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(com.local.hive.mobile.link.PcTheme.serializer()), pcFile.readText())
    }.getOrDefault(emptyList())
    /**
     * The phone's own colourful set (see [ThemeMaker.SUITE]) rather than every
     * theme in Hive's themes folder on the PC, most of which are the same near
     * black with another accent. Your Hive theme leads; Custom closes the list.
     */
    @Suppress("UNUSED_PARAMETER")
    private fun packsFrom(pc: List<com.local.hive.mobile.link.PcTheme>): List<ThemePack> =
        listOf(ThemePack(YOUR_THEME, yourHiveCss())) + ThemeMaker.SUITE.map(ThemeMaker::pack) + customPack()

    // ---- Custom: a background and an accent of the user's own (phone only) ----

    private val _custom = MutableStateFlow(
        Color(prefs.getInt("custom.bg", 0xFF2B2140.toInt())) to Color(prefs.getInt("custom.accent", 0xFFFFB347.toInt())),
    )
    /** The Custom theme's background and accent. */
    val custom: StateFlow<Pair<Color, Color>> = _custom.asStateFlow()
    private fun customPack() = ThemePack(CUSTOM, ThemeMaker.css(_custom.value.first, _custom.value.second))

    /** Shows the Custom theme as last saved. */
    fun applyCustom() = apply(customPack().css, CUSTOM)

    /** Sets and shows the Custom theme. */
    fun setCustom(bg: Color, accent: Color) {
        prefs.edit { putInt("custom.bg", bg.toArgb()); putInt("custom.accent", accent.toArgb()) }
        _custom.value = bg to accent
        _packs.value = packsFrom(emptyList())
        apply(customPack().css, CUSTOM)
    }

    /** "Your Hive theme" (the one from Hive on the PC), the phone's theme set, then Custom. */
    private val _packs = MutableStateFlow(emptyList<ThemePack>())
    val packs: StateFlow<List<ThemePack>> get() { if (_packs.value.isEmpty()) _packs.value = packsFrom(loadPc()); return _packs.asStateFlow() }

    fun setPcThemes(themes: List<com.local.hive.mobile.link.PcTheme>, current: com.local.hive.mobile.link.PcTheme? = null) {
        runCatching { pcFile.writeText(themeJson.encodeToString(kotlinx.serialization.builtins.ListSerializer(com.local.hive.mobile.link.PcTheme.serializer()), themes)) }
        // Your Hive theme is the one Hive shows now; while it's the phone's theme, the phone follows a change.
        val css = current?.css?.takeIf { it.contains("--") }
        if (css != null && css != prefs.getString("pc.current", null)) {
            prefs.edit { putString("pc.current", css) }
            if (_name.value == YOUR_THEME) _colors.value = load()
        }
        _packs.value = packsFrom(themes)
    }

    /** The accent: the theme's own, or (true) taken from the playing song's cover. */
    private val _accentFromCover = MutableStateFlow(prefs.getBoolean("accentFromCover", prefs.getString("name", null) == null))
    val accentFromCover: StateFlow<Boolean> = _accentFromCover.asStateFlow()
    fun setAccentFromCover(on: Boolean) { prefs.edit { putBoolean("accentFromCover", on) }; _accentFromCover.value = on }

    fun apply(css: String, name: String = "Custom") {
        show(css, name)
        // Choosing a theme shows its own accent; the cover can take over again in Appearance.
        setAccentFromCover(false)
    }

    fun reset() {
        show(null, YOUR_THEME)
        // Your Hive theme takes its accent from the playing cover, as Hive does on the PC.
        setAccentFromCover(true)
    }

    /** Shows a theme (null css: Your Hive theme) without touching the Accent choice. */
    private fun show(css: String?, name: String) {
        prefs.edit { if (css == null) { remove("css"); remove("name") } else { putString("css", css); putString("name", name) } }
        _colors.value = load()
        _name.value = name
    }

    // ---- Scheduled theme ----
    private val _schedule = MutableStateFlow(ThemeSchedule(
        enabled = prefs.getBoolean("sched.enabled", false),
        dayStart = prefs.getString("sched.day", null) ?: ThemeSchedule().dayStart,
        nightStart = prefs.getString("sched.night", null) ?: ThemeSchedule().nightStart,
        dayTheme = prefs.getString("sched.dayTheme", null) ?: ThemeSchedule().dayTheme,
        nightTheme = prefs.getString("sched.nightTheme", null) ?: ThemeSchedule().nightTheme,
    ))
    val schedule: StateFlow<ThemeSchedule> = _schedule.asStateFlow()

    fun setSchedule(s: ThemeSchedule) {
        prefs.edit {
            putBoolean("sched.enabled", s.enabled); putString("sched.day", s.dayStart); putString("sched.night", s.nightStart)
            putString("sched.dayTheme", s.dayTheme); putString("sched.nightTheme", s.nightTheme)
            remove("sched.applied")
        }
        _schedule.value = s
        checkSchedule()
    }

    /** Shows the scheduled theme once per switch (a theme picked by hand stays until the next switch). */
    fun checkSchedule(now: java.time.LocalDateTime = java.time.LocalDateTime.now()) {
        val s = _schedule.value
        if (!s.enabled) return
        val period = s.periodAt(now.toLocalTime())
        val key = "$period@${s.lastSwitch(now)}"
        if (prefs.getString("sched.applied", null) == key) return
        val pack = s.themeFor(period, packs.value, _name.value) ?: return
        if (pack.name == YOUR_THEME) show(null, YOUR_THEME) else show(pack.css, pack.name)
        prefs.edit { putString("sched.applied", key) }
    }

    /** Checks the schedule every half minute while Hive runs. */
    fun runSchedule(scope: kotlinx.coroutines.CoroutineScope) = scope.launch {
        while (true) { runCatching { checkSchedule() }; kotlinx.coroutines.delay(30_000) }
    }

    companion object { const val YOUR_THEME = "Your Hive theme"; const val CUSTOM = "Custom" }

    private fun load() = HiveColors.fromCss(css)
    private fun bundledCss() = runCatching { context.assets.open("default-theme.css").bufferedReader().readText() }.getOrDefault("")
}

val LocalHiveColors = staticCompositionLocalOf { HiveColors.Default }

object Hive {
    val colors: HiveColors @Composable get() = LocalHiveColors.current
}

