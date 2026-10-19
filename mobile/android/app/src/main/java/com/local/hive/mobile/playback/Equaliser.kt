package com.local.hive.mobile.playback

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** A 10-band preset in Hive's (MusicBee's) model: gains and preamp in dB. */
@Serializable
data class EqPreset(val name: String, val preamp: Float, val gains: List<Float>)

/** What the equaliser is doing: [preset] names a preset, [MANUAL] or [AUTO_GENRE]. */
@Serializable
data class EqState(
    val enabled: Boolean = false,
    val preset: String = "Flat",
    val manual: EqPreset = EqPreset(MANUAL, 0f, List(10) { 0f }),
    val custom: List<EqPreset> = emptyList(),
) {
    val presets: List<EqPreset> get() = BUILT_IN + custom

    /** The curve to apply now; for [AUTO_GENRE], the preset named like [genre]. */
    fun curve(genre: String = ""): EqPreset = when (preset) {
        MANUAL -> manual
        AUTO_GENRE -> presetForGenre(presets, genre) ?: BUILT_IN.first()
        else -> presets.firstOrNull { it.name == preset } ?: BUILT_IN.first()
    }

    companion object {
        const val MANUAL = "Manual"
        const val AUTO_GENRE = "Auto-Select by Genre"
        const val MIN_DB = -15f
        const val MAX_DB = 12f

        /** MusicBee's 10-band centre frequencies. */
        val FREQUENCIES = floatArrayOf(31.25f, 62.5f, 125f, 250f, 500f, 1000f, 2000f, 4000f, 8000f, 16000f)

        // Hive's built-in starting points, the same as on the PC.
        val BUILT_IN = listOf(
            "Flat" to (0f to listOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
            "Bass Booster" to (-3f to listOf(6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0)),
            "Bass Reducer" to (0f to listOf(-6, -5, -4, -2.5, -1, 0, 0, 0, 0, 0)),
            "Treble Booster" to (-3f to listOf(0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6)),
            "Treble Reducer" to (0f to listOf(0, 0, 0, 0, 0, -1, -2.5, -4, -5, -6)),
            "Vocal Booster" to (-2f to listOf(-2, -2, -1, 1, 3, 3.5, 3, 1.5, 0, -1)),
            "Loudness" to (-4f to listOf(5, 4, 1.5, 0, -1, 0, 0, 1.5, 4, 3)),
            "Small Speakers" to (-3f to listOf(4.5, 4, 3, 1.5, 0, -0.5, 0, 1, 2, 2.5)),
            "Spoken Word" to (-1f to listOf(-4, -2, 0, 1, 3, 4, 4, 2, 0, -3)),
            "Acoustic" to (-2f to listOf(3.5, 3, 2.5, 1, 1.5, 1.5, 2.5, 3, 2.5, 1.5)),
            "Classical" to (-1f to listOf(3.5, 3, 2.5, 2, -1, -1, 0, 2, 2.5, 3)),
            "Dance" to (-3f to listOf(4, 6, 4.5, 0, 1.5, 3, 4.5, 4, 3, 0)),
            "Electronic" to (-3f to listOf(4, 3.5, 1, 0, -2, 2, 1, 1.5, 4, 5)),
            "Hip-Hop" to (-3f to listOf(5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3)),
            "Jazz" to (-2f to listOf(3.5, 2.5, 1, 2, -1.5, -1.5, 0, 1.5, 3, 3.5)),
            "Pop" to (-2f to listOf(-1, -0.5, 0, 2, 4, 4, 2, 0, -0.5, -1)),
            "RnB" to (-3f to listOf(2.5, 6.5, 5, 1.5, -2.5, -1.5, 2, 2.5, 3, 3.5)),
            "Rock" to (-3f to listOf(5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5)),
            "Metal" to (-3f to listOf(4.5, 4, 2, 0, -2, -1, 1, 3, 4, 3)),
            "Reggae" to (-2f to listOf(0, 0, 0, -3, 0, 3.5, 3.5, 0, 0, 0)),
        ).map { (name, p) -> EqPreset(name, p.first, p.second.map { it.toFloat() }) }

        /** MusicBee's "Auto-Select by Genre": the preset named like the genre ("Hip Hop/Rap" finds "Hip-Hop"). */
        fun presetForGenre(presets: List<EqPreset>, genre: String): EqPreset? {
            fun key(s: String) = s.lowercase().replace(Regex("[^a-z0-9]+"), "")
            for (part in genre.split(Regex("[;/,|]+")).map(::key).filter { it.isNotEmpty() }) {
                presets.firstOrNull { key(it.name) == part || (part.startsWith(key(it.name)) && key(it.name).length >= 3) }?.let { return it }
            }
            return null
        }

        /** Each band spans halfway to its neighbours on a log scale (one octave for 10 bands), in Hz. */
        fun bandwidth(i: Int): Float {
            val f = FREQUENCIES[i]
            val ratio = if (i < FREQUENCIES.size - 1) FREQUENCIES[i + 1] / f else f / FREQUENCIES[i - 1]
            return f * (sqrt(ratio) - 1 / sqrt(ratio))
        }

        /** The curve's total gain in dB at [hz], as the filters shape it (for drawing the response). */
        fun responseDb(p: EqPreset, hz: Double, rate: Double = 48_000.0): Double {
            var total = p.preamp.toDouble()
            val w = 2 * PI * hz / rate
            for (i in FREQUENCIES.indices) {
                val g = p.gains.getOrElse(i) { 0f }.toDouble()
                if (g == 0.0) continue
                val f0 = FREQUENCIES[i].toDouble()
                val a = 10.0.pow(g / 40.0)
                val w0 = 2 * PI * f0 / rate
                val alpha = sin(w0) / (2 * (f0 / bandwidth(i)))
                val b0 = 1 + alpha * a; val b1 = -2 * cos(w0); val b2 = 1 - alpha * a
                val a0 = 1 + alpha / a; val a1 = -2 * cos(w0); val a2 = 1 - alpha / a
                // |H(e^jw)|^2 from the numerator and denominator polynomials.
                fun mag2(c0: Double, c1: Double, c2: Double): Double {
                    val re = c0 + c1 * cos(w) + c2 * cos(2 * w); val im = -(c1 * sin(w) + c2 * sin(2 * w))
                    return re * re + im * im
                }
                total += 10 * kotlin.math.log10(mag2(b0, b1, b2) / mag2(a0, a1, a2))
            }
            return total
        }

        /** MusicBee .sde text, so presets move between Hive on the PC, MusicBee and the phone. */
        fun parseSde(text: String, name: String): EqPreset? {
            val values = text.lineSequence().mapNotNull { Regex("""^\s*([A-Za-z]+\d*)\s*=\s*(.*?)\s*$""").find(it) }
                .associate { it.groupValues[1].lowercase() to it.groupValues[2] }
            if (values.isEmpty()) return null
            fun num(k: String) = values[k]?.replace(',', '.')?.toFloatOrNull() ?: 0f
            fun avg(l: String, r: String) = if (values[r] == null) num(l) else (num(l) + num(r)) / 2
            val count = if ((values["bands"]?.toIntOrNull() ?: 10) == 15) 15 else 10
            val raw = (1..count).map { avg("left$it", "right$it").coerceIn(MIN_DB, MAX_DB) }
            // A 15-band preset is folded onto the 10 bands by log-frequency interpolation.
            val gains = if (count == 10) raw else resample15(raw)
            return EqPreset(name, avg("leftpreamp", "rightpreamp").coerceIn(MIN_DB, MAX_DB), gains)
        }

        fun serializeSde(p: EqPreset): String = buildString {
            fun fmt(v: Float) = "%.1f".format(java.util.Locale.ROOT, v)
            append("[Equalizer]\r\nLeftPreamp=${fmt(p.preamp)}\r\nRightPreamp=${fmt(p.preamp)}\r\n")
            p.gains.forEachIndexed { i, g -> append("Left${i + 1}=${fmt(g)}\r\nRight${i + 1}=${fmt(g)}\r\n") }
            append("Bands=10\r\n")
        }

        private val FREQ15 = floatArrayOf(31.25f, 49.2f, 77.5f, 122f, 192.3f, 302.9f, 477f, 751.3f, 1183.3f, 1863.7f, 2935.3f, 4623.1f, 7281.4f, 11468.3f, 18062.5f)
        private fun resample15(g: List<Float>): List<Float> {
            val from = FREQ15.map { kotlin.math.ln(it) }
            return FREQUENCIES.map { f ->
                val x = kotlin.math.ln(f)
                when {
                    x <= from.first() -> g.first()
                    x >= from.last() -> g.last()
                    else -> { val i = from.indexOfLast { it <= x }; val t = (x - from[i]) / (from[i + 1] - from[i]); g[i] + t * (g[i + 1] - g[i]) }
                }
            }
        }
    }
}

/** The phone's equaliser settings, shared by the screen and the player. */
class EqualiserStore(context: Context) {
    private val prefs = context.getSharedPreferences("equaliser", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val _state = MutableStateFlow(prefs.getString("state", null)?.let { runCatching { json.decodeFromString<EqState>(it) }.getOrNull() } ?: EqState())
    val state: StateFlow<EqState> = _state.asStateFlow()

    fun update(change: (EqState) -> EqState) {
        val next = change(_state.value)
        _state.value = next
        prefs.edit().putString("state", json.encodeToString(EqState.serializer(), next)).apply()
    }
}

/**
 * Hive's equaliser inside ExoPlayer: the same peaking filters at MusicBee's
 * centre frequencies and widths as Hive on the PC, so a preset sounds the
 * same on every output, Bluetooth included. Gains change without a gap.
 */
@UnstableApi
class EqualiserProcessor : BaseAudioProcessor() {
    private class Biquad(val b0: Float, val b1: Float, val b2: Float, val a1: Float, val a2: Float)

    @Volatile private var target: EqPreset? = null
    @Volatile private var dirty = true
    private var filters: Array<Biquad> = emptyArray()
    private var preampGain = 1f
    private var channels = 2
    private var rate = 44_100
    private var encoding = C.ENCODING_PCM_16BIT
    // Per band, per channel: the two delay-line values (transposed direct form II).
    private var z1 = FloatArray(0)
    private var z2 = FloatArray(0)

    /** The curve to apply, or null for off. */
    fun setCurve(preset: EqPreset?) { target = preset; dirty = true }

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
        channels = inputAudioFormat.channelCount
        rate = inputAudioFormat.sampleRate
        encoding = inputAudioFormat.encoding
        dirty = true
        return inputAudioFormat
    }

    private fun rebuild() {
        dirty = false
        val p = target
        if (p == null || (p.preamp == 0f && p.gains.all { it == 0f })) { filters = emptyArray(); preampGain = 1f; return }
        preampGain = 10f.pow(p.preamp / 20f)
        filters = EqState.FREQUENCIES.indices.mapNotNull { i ->
            val f0 = EqState.FREQUENCIES[i]
            val db = p.gains.getOrElse(i) { 0f }
            if (db == 0f || f0 >= rate / 2f * 0.95f) return@mapNotNull null
            val a = 10.0.pow(db / 40.0)
            val w0 = 2 * PI * f0 / rate
            val alpha = sin(w0) / (2 * (f0 / EqState.bandwidth(i)))
            val a0 = 1 + alpha / a
            Biquad(((1 + alpha * a) / a0).toFloat(), (-2 * cos(w0) / a0).toFloat(), ((1 - alpha * a) / a0).toFloat(), (-2 * cos(w0) / a0).toFloat(), ((1 - alpha / a) / a0).toFloat())
        }.toTypedArray()
        if (z1.size != filters.size * channels) { z1 = FloatArray(filters.size * channels); z2 = FloatArray(filters.size * channels) }
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        if (dirty) rebuild()
        val size = inputBuffer.remaining()
        if (size == 0) return
        val out = replaceOutputBuffer(size).order(ByteOrder.nativeOrder())
        val input = inputBuffer.order(ByteOrder.nativeOrder())
        if (filters.isEmpty() && preampGain == 1f) { out.put(input); out.flip(); return }
        val float = encoding == C.ENCODING_PCM_FLOAT
        var ch = 0
        while (input.hasRemaining()) {
            var x = if (float) input.getFloat() else input.getShort() / 32768f
            x *= preampGain
            for (b in filters.indices) {
                val f = filters[b]
                val k = b * channels + ch
                val y = f.b0 * x + z1[k]
                z1[k] = f.b1 * x - f.a1 * y + z2[k]
                z2[k] = f.b2 * x - f.a2 * y
                x = y
            }
            if (float) out.putFloat(x) else out.putShort((x.coerceIn(-1f, 0.99997f) * 32768f).toInt().toShort())
            ch = (ch + 1) % channels
        }
        out.flip()
    }

    override fun onFlush() { z1.fill(0f); z2.fill(0f) }
    override fun onReset() { filters = emptyArray(); z1 = FloatArray(0); z2 = FloatArray(0); dirty = true }
}
