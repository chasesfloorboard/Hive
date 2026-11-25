package com.local.hive.mobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.PluginGallery
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.playback.SpectrumBus
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveIcons
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.pow

/**
 * Pure Monstercat Visualizer shaping math — 1-to-1 with desktop's
 * `resources/hive-plugins/monstercat-visualizer/plugin.js`.
 */
internal class VisualizerShaper {
    var refDb: Float = -30f
        private set

    fun levelToDb(level: Float): Float = FLOOR_DB + level.coerceIn(0f, 1f) * -FLOOR_DB

    fun resample(values: FloatArray, count: Int): FloatArray {
        val out = FloatArray(count)
        val n = values.size
        if (n == 0 || count <= 0) return out
        for (i in 0 until count) {
            val start = i.toFloat() * n / count
            val end = (i + 1).toFloat() * n / count
            if (end - start >= 1f) {
                var maxVal = 0f
                val lo = floor(start).toInt().coerceIn(0, n - 1)
                val hi = ceil(end).toInt().coerceIn(lo + 1, n)
                for (b in lo until hi) {
                    if (values[b] > maxVal) maxVal = values[b]
                }
                out[i] = maxVal
            } else {
                val pos = ((start + end) / 2f - 0.5f).coerceIn(0f, (n - 1).toFloat())
                val lo = floor(pos).toInt()
                val hi = (lo + 1).coerceAtMost(n - 1)
                out[i] = values[lo] + (values[hi] - values[lo]) * (pos - lo)
            }
        }
        return out
    }

    fun monstercatSpread(values: FloatArray, factor: Float = 1.5f): FloatArray {
        val out = values.copyOf()
        for (i in values.indices) {
            val vi = values[i]
            if (vi <= 0.0005f) continue
            for (j in values.indices) {
                if (i == j) continue
                val spread = vi / factor.pow(abs(i - j))
                if (spread > out[j]) out[j] = spread
            }
        }
        return out
    }

    fun shapeFrame(
        levels: FloatArray,
        barCount: Int,
        sensitivityDb: Float,
        monstercatSmoothing: Boolean,
        dtSeconds: Float,
    ): FloatArray {
        val count = barCount.coerceIn(16, 128)
        val dbs = FloatArray(levels.size) { levelToDb(levels[it]) }
        var peak = FLOOR_DB
        for (db in dbs) if (db > peak) peak = db
        if (peak < SILENCE_DB) return FloatArray(count)
        refDb = maxOf(peak, refDb - 6f * dtSeconds.coerceAtLeast(0f), MIN_REF_DB)
        val sens = sensitivityDb.coerceIn(15f, 70f)
        val bottom = refDb - sens
        val normalized = FloatArray(dbs.size) { ((dbs[it] - bottom) / sens).coerceIn(0f, 1f) }
        val bars = resample(normalized, count)
        return if (monstercatSmoothing) monstercatSpread(bars) else bars
    }

    fun stepBars(current: FloatArray, target: FloatArray, dtSeconds: Float, decayMs: Float): FloatArray {
        val out = if (current.size == target.size) current else FloatArray(target.size)
        val dt = dtSeconds.coerceIn(0.001f, 0.1f)
        val attack = 1f - exp(-dt / 0.012f)
        val decay = 1f - exp(-dt / (decayMs.coerceIn(20f, 400f) / 1000f))
        for (i in target.indices) {
            val from = out[i]
            val to = target[i]
            val next = from + (to - from) * (if (to > from) attack else decay)
            out[i] = if (abs(next - to) < 0.001f) to else next
        }
        return out
    }

    companion object {
        private const val FLOOR_DB = -80f
        private const val MIN_REF_DB = -36f
        private const val SILENCE_DB = -62f
        const val GAP_RATIO = 7f / 18f
        const val MIN_BAR = 0.012f
    }
}

/** Visualizer tab embedded inside HomeScreen when the Monstercat Visualizer plugin is enabled. */
@Composable
fun VisualizerTab(
    vm: MainViewModel,
    bottomPadding: Dp,
    active: Boolean = true,
    onOpenFullScreen: () -> Unit,
    onOpenPluginStore: () -> Unit,
) {
    AllowLandscape(active)
    val installed by vm.plugins.installed.collectAsStateWithLifecycle()
    val plugin = installed.firstOrNull { it.plugin.id == PluginGallery.MONSTERCAT_ID && it.enabled }
    if (plugin == null) {
        Box(Modifier.fillMaxSize().padding(bottom = bottomPadding), contentAlignment = Alignment.Center) {
            EmptyState(
                "Visualizer plugin is turned off",
                "Enable Monstercat Visualizer in Settings › Plugins & Store to use the Visualizer tab.",
                icon = Icons.Rounded.Tune,
                action = "Open Plugin Store" to onOpenPluginStore,
            )
        }
        return
    }
    var editingSettings by remember { mutableStateOf(false) }
    VisualizerStage(
        vm = vm,
        modifier = Modifier.fillMaxSize().padding(bottom = bottomPadding),
        fullscreen = false,
        onBack = null,
        onToggleFullscreen = onOpenFullScreen,
        onOpenSettings = { editingSettings = true },
    )
    if (editingSettings) {
        PluginSettingsDialog(vm, plugin) { editingSettings = false }
    }
}

/** Full-screen Visualizer route ("visualizer"), with full landscape support and transport controls. */
@Composable
fun VisualizerScreen(vm: MainViewModel, onBack: () -> Unit) {
    AllowLandscape(true)
    val installed by vm.plugins.installed.collectAsStateWithLifecycle()
    val plugin = installed.firstOrNull { it.plugin.id == PluginGallery.MONSTERCAT_ID }
    var editingSettings by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(Hive.colors.bg).statusBarsPadding().navigationBarsPadding()) {
        VisualizerStage(
            vm = vm,
            modifier = Modifier.fillMaxSize(),
            fullscreen = true,
            onBack = onBack,
            onToggleFullscreen = null,
            onOpenSettings = { if (plugin != null) editingSettings = true },
        )
    }
    if (editingSettings && plugin != null) {
        PluginSettingsDialog(vm, plugin) { editingSettings = false }
    }
}

@Composable
private fun VisualizerStage(
    vm: MainViewModel,
    modifier: Modifier,
    fullscreen: Boolean,
    onBack: (() -> Unit)?,
    onToggleFullscreen: (() -> Unit)?,
    onOpenSettings: () -> Unit,
) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val installed by vm.plugins.installed.collectAsStateWithLifecycle()
    val vizPlugin = installed.firstOrNull { it.plugin.id == PluginGallery.MONSTERCAT_ID }
    val barCount = remember(vizPlugin?.settings) {
        vizPlugin?.settings?.get("barCount")?.toDoubleOrNull()?.toInt()?.coerceIn(16, 128) ?: 48
    }
    val sensitivity = remember(vizPlugin?.settings) {
        vizPlugin?.settings?.get("sensitivity")?.toFloatOrNull()?.coerceIn(15f, 70f) ?: 35f
    }
    val decayMs = remember(vizPlugin?.settings) {
        vizPlugin?.settings?.get("decayMs")?.toFloatOrNull()?.coerceIn(20f, 400f) ?: 90f
    }
    val smooth = remember(vizPlugin?.settings) {
        vizPlugin?.settings?.get("monstercatSmoothing")?.toBooleanStrictOrNull() ?: true
    }
    val useAccent = remember(vizPlugin?.settings) {
        vizPlugin?.settings?.get("accentColor")?.toBooleanStrictOrNull() ?: true
    }

    // Attach to ExoPlayer's real-time SpectrumBus only while this screen is on screen.
    DisposableEffect(Unit) {
        SpectrumBus.acquire()
        onDispose { SpectrumBus.release() }
    }

    val shaper = remember { VisualizerShaper() }
    var drawnBars by remember(barCount) { mutableStateOf(FloatArray(barCount)) }
    val rawLevels by SpectrumBus.levels.collectAsStateWithLifecycle()
    val latestLevels = androidx.compose.runtime.rememberUpdatedState(rawLevels)
    val latestPlaying = androidx.compose.runtime.rememberUpdatedState(now.isPlaying)

    LaunchedEffect(barCount, sensitivity, decayMs, smooth) {
        var lastNs = 0L
        var state = FloatArray(barCount)
        while (true) {
            withFrameNanos { nowNs ->
                val dt = if (lastNs == 0L) 1f / 60f else ((nowNs - lastNs) / 1_000_000_000f).coerceIn(0.001f, 0.1f)
                lastNs = nowNs
                val target = if (latestPlaying.value) {
                    shaper.shapeFrame(latestLevels.value, barCount, sensitivity, smooth, dt)
                } else {
                    FloatArray(barCount)
                }
                state = shaper.stepBars(state, target, dt, decayMs)
                drawnBars = state.copyOf()
            }
        }
    }

    val barColor = if (useAccent) c.accent else c.text

    BoxWithConstraints(modifier) {
        val stageMaxH = maxHeight
        val landscape = maxWidth > stageMaxH
        Column(Modifier.fillMaxSize()) {
            // Compact action header
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = if (landscape) 2.dp else 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (onBack != null) {
                    BarIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack)
                    Text("Visualizer", style = HiveText.rowStrong, color = c.text, modifier = Modifier.weight(1f).padding(start = 6.dp))
                } else {
                    Text(
                        "Monstercat Visualizer",
                        style = HiveText.small,
                        color = c.textDim,
                        modifier = Modifier.weight(1f).padding(start = 10.dp),
                    )
                }
                BarIcon(Icons.Rounded.Tune, "Visualizer settings", onOpenSettings, tint = c.textDim)
                if (onToggleFullscreen != null) {
                    BarIcon(Icons.Rounded.Fullscreen, "Full screen", onToggleFullscreen, tint = c.textDim)
                }
            }

            // Main Monstercat stage: spectrum bars above artwork + bold uppercase artist + title
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = if (landscape) 36.dp else 20.dp, vertical = if (landscape) 8.dp else 16.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Canvas(
                    Modifier
                        .fillMaxWidth()
                        .height(if (landscape) (stageMaxH * 0.44f).coerceIn(96.dp, 220.dp) else (stageMaxH * 0.32f).coerceIn(130.dp, 260.dp))
                ) {
                    val count = drawnBars.size.coerceAtLeast(1)
                    val gapRatio = VisualizerShaper.GAP_RATIO
                    val barW = size.width / (count + (count - 1) * gapRatio)
                    val gap = barW * gapRatio
                    val step = barW + gap
                    val radius = CornerRadius(barW * 0.22f, barW * 0.22f)
                    for (i in 0 until count) {
                        val v = drawnBars[i].coerceIn(0f, 1f)
                        val h = maxOf(size.height * VisualizerShaper.MIN_BAR, v * size.height)
                        val x = i * step
                        val y = size.height - h
                        drawRoundRect(
                            color = barColor,
                            topLeft = Offset(x, y),
                            size = Size(barW.coerceAtLeast(1f), h),
                            cornerRadius = radius,
                        )
                    }
                }

                Spacer(Modifier.height(if (landscape) 14.dp else 22.dp))

                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(if (landscape) 18.dp else 14.dp),
                ) {
                    val artSize = if (landscape) 72.dp else 88.dp
                    Artwork(
                        now.artworkUri,
                        Modifier.size(artSize).clip(RoundedCornerShape(8.dp)),
                        RoundedCornerShape(8.dp),
                        if (now.isLive) Icons.Rounded.Radio else Icons.Rounded.MusicNote,
                        highQuality = true,
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            now.artist.ifBlank { if (now.mediaId != null) "Unknown artist" else "Hive" }.uppercase(),
                            style = HiveText.viewTitle.copy(
                                fontSize = if (landscape) 26.sp else 24.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 0.4.sp,
                            ),
                            color = c.text,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            now.title.ifBlank { "Play a song to see live bars" },
                            style = HiveText.rowStrong.copy(
                                fontSize = if (landscape) 17.sp else 16.sp,
                                fontWeight = FontWeight.Light,
                            ),
                            color = c.textDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (fullscreen) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            SkipButton(HiveIcons.Previous, "Previous", forward = false, vm = vm, size = 44.dp, iconSize = 24.dp)
                            AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 48.dp)
                            SkipButton(HiveIcons.Next, "Next", forward = true, vm = vm, size = 44.dp, iconSize = 24.dp)
                        }
                    }
                }
            }
        }
    }
}
