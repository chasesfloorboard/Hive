package com.local.hive.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.playback.EqPreset
import com.local.hive.mobile.playback.EqState
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * Hive's equaliser: MusicBee's ten bands and presets, the curve drawn as it
 * shapes the sound, a fader per band and the preamp. Moving a fader turns the
 * curve into "Manual"; Save keeps it as a preset.
 */
@Composable
fun EqualiserScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit) {
    val c = Hive.colors
    val state by vm.equaliser.state.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val genre by vm.currentGenre.collectAsStateWithLifecycle()
    val curve = state.curve(genre)
    var naming by remember { mutableStateOf(false) }
    val dim by animateFloatAsState(if (state.enabled) 1f else 0.45f, tween(180), label = "eqDim")

    fun edit(change: (EqPreset) -> EqPreset) = vm.equaliser.update { it.copy(preset = EqState.MANUAL, manual = change(curve).copy(name = EqState.MANUAL), enabled = true) }

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 2.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Equaliser", style = HiveText.viewTitle, color = c.text)
                        Text(
                            when {
                                !state.enabled -> "Off"
                                state.preset == EqState.AUTO_GENRE -> "Auto: ${curve.name}" + if (now.trackId != null && genre.isNotBlank()) " for $genre" else ""
                                else -> curve.name
                            },
                            style = HiveText.small, color = c.textDim,
                        )
                    }
                    HiveToggle(listOf("Off", "On"), if (state.enabled) 1 else 0, { i -> vm.equaliser.update { it.copy(enabled = i == 1) } })
                }
            }
            item { ResponseCurve(curve, Modifier.alpha(dim)) }
            item {
                LazyRow(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val names = listOf(EqState.AUTO_GENRE, EqState.MANUAL) + state.presets.map { it.name }
                    items(names) { name -> HivePill(if (name == EqState.AUTO_GENRE) "Auto by genre" else name, active = state.enabled && state.preset == name) { vm.equaliser.update { it.copy(preset = name, enabled = true) } } }
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp).hiveGlass(HiveShape.panel).padding(horizontal = 6.dp, vertical = 14.dp).alpha(dim), horizontalArrangement = Arrangement.SpaceBetween) {
                    Fader("Pre", curve.preamp) { v -> edit { it.copy(preamp = v) } }
                    Box(Modifier.width(1.dp).height(230.dp).background(c.border))
                    EqState.FREQUENCIES.forEachIndexed { i, f ->
                        Fader(if (f >= 1000) "${(f / 1000).let { if (it % 1f == 0f) it.toInt().toString() else "%.1f".format(it) }}k" else f.roundToInt().toString(), curve.gains[i]) { v ->
                            edit { p -> p.copy(gains = p.gains.toMutableList().also { it[i] = v }) }
                        }
                    }
                }
            }
            item {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HivePill("Save as preset", active = false) { naming = true }
                    HivePill("Reset", active = false) { vm.equaliser.update { it.copy(preset = EqState.MANUAL, manual = EqPreset(EqState.MANUAL, 0f, List(10) { 0f })) } }
                    if (state.custom.any { it.name == state.preset }) HivePill("Delete preset", active = false) {
                        vm.equaliser.update { s -> s.copy(custom = s.custom.filterNot { it.name == s.preset }, preset = EqState.MANUAL, manual = curve.copy(name = EqState.MANUAL)) }
                    }
                }
            }
            item { Text("Double-tap a fader to set it back to 0 dB. Presets are MusicBee's, as in Hive on your PC.", style = HiveText.small, color = c.textDimmer, modifier = Modifier.padding(horizontal = 22.dp)) }
        }
    }
    if (naming) NameDialog("Save preset", if (curve.name == EqState.MANUAL) "" else curve.name, "Save", onDismiss = { naming = false }) { name ->
        naming = false
        val clean = name.trim()
        vm.equaliser.update { s -> s.copy(custom = s.custom.filterNot { it.name == clean } + curve.copy(name = clean), preset = clean, enabled = true) }
    }
}

/** The equaliser's frequency response from 20 Hz to 20 kHz, ±15 dB. */
@Composable
private fun ResponseCurve(curve: EqPreset, modifier: Modifier) {
    val c = Hive.colors
    val points = remember(curve) {
        (0..120).map { i -> val hz = 20.0 * Math.pow(1000.0, i / 120.0); i / 120f to EqState.responseDb(curve, hz).toFloat() }
    }
    Canvas(modifier.fillMaxWidth().padding(horizontal = 14.dp).height(150.dp).hiveGlass(HiveShape.panel)) {
        val pad = 14.dp.toPx()
        val h = size.height - pad * 2
        fun y(db: Float) = pad + h / 2 - (db.coerceIn(-15f, 15f) / 15f) * (h / 2)
        // 0 dB and the band centres.
        drawLine(c.border, Offset(0f, y(0f)), Offset(size.width, y(0f)), 1.dp.toPx())
        EqState.FREQUENCIES.forEach { f ->
            val x = (ln(f / 20.0) / ln(1000.0)).toFloat() * size.width
            drawLine(c.border.copy(alpha = c.border.alpha * 0.5f), Offset(x, pad), Offset(x, size.height - pad), 1.dp.toPx())
        }
        val line = Path()
        points.forEachIndexed { i, (t, db) -> val x = t * size.width; if (i == 0) line.moveTo(x, y(db)) else line.lineTo(x, y(db)) }
        val fill = Path().apply { addPath(line); lineTo(size.width, y(0f)); lineTo(0f, y(0f)); close() }
        drawPath(fill, Brush.verticalGradient(listOf(c.accent.copy(alpha = 0.32f), c.accent.copy(alpha = 0.02f), c.accent.copy(alpha = 0.32f))))
        drawPath(line, c.accent, style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round))
    }
}

/** One vertical fader, −15…+12 dB: drag to set, double-tap for 0 dB. */
@Composable
private fun Fader(label: String, db: Float, onChange: (Float) -> Unit) {
    val c = Hive.colors
    val range = EqState.MAX_DB - EqState.MIN_DB
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(28.dp)) {
        val shown = if (db % 1f == 0f) "%.0f".format(db) else "%.1f".format(db)
        Text(if (db > 0) "+$shown" else shown, style = HiveText.label, color = if (db != 0f) c.accent else c.textDimmer, textAlign = TextAlign.Center)
        // The gesture outlives each change of value, so it reads the latest through these.
        val current by rememberUpdatedState(db)
        val report by rememberUpdatedState(onChange)
        Canvas(
            Modifier.padding(vertical = 8.dp).width(28.dp).height(190.dp)
                .pointerInput(Unit) { detectTapGestures(onDoubleTap = { report(0f) }) }
                .pointerInput(Unit) {
                    var value = 0f
                    detectVerticalDragGestures(onDragStart = { value = current }) { change, amount ->
                        change.consume()
                        value = (value - amount / size.height * range).coerceIn(EqState.MIN_DB, EqState.MAX_DB)
                        // Half-dB steps, as MusicBee's faders.
                        report((value * 2).roundToInt() / 2f)
                    }
                },
        ) {
            val x = size.width / 2
            fun y(v: Float) = size.height * (1 - (v - EqState.MIN_DB) / range)
            drawLine(c.text.copy(alpha = 0.12f), Offset(x, 0f), Offset(x, size.height), 4.dp.toPx(), StrokeCap.Round)
            drawLine(c.accent, Offset(x, y(0f)), Offset(x, y(db)), 4.dp.toPx(), StrokeCap.Round)
            drawCircle(c.accentGlow, 13.dp.toPx(), Offset(x, y(db)))
            drawCircle(Color.White, 8.dp.toPx(), Offset(x, y(db)))
        }
        Text(label, style = HiveText.label, color = c.textDim, textAlign = TextAlign.Center)
    }
}
