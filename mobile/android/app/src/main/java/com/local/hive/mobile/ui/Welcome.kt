package com.local.hive.mobile.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Palette
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.mix
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/** One page of the welcome walk-through: a floating illustration, a line, and a few words. */
private class Step(val icon: ImageVector, val title: String, val body: String)

private val STEPS = listOf(
    Step(Icons.Rounded.MusicNote, "Welcome to Hive", "Your own music player — the songs already on this phone, in a library that's yours to arrange."),
    Step(Icons.Rounded.LibraryMusic, "Play your music", "Everything on this phone, sorted into albums, artists and genres. Hive needs permission to read it."),
    Step(Icons.Rounded.Devices, "Link your PC", "Open Hive on your computer and pair this phone in Settings — favourites, plays and playlists then stay in step across both."),
    Step(Icons.Rounded.Palette, "Make it yours", "Themes, the equaliser and your own playlists all live in Settings. Tune Hive to taste whenever you like."),
)

private const val PERMISSION_PAGE = 1

/**
 * The first thing a brand-new install shows: a short, moving walk-through that says what Hive is,
 * asks for the one permission it needs, and points the way to linking and personalising. It shows
 * once — a "seenWelcome" flag in the phone's settings — and never stacks on top of the returning-user
 * restore offer, which speaks for someone who has used Hive before.
 */
@Composable
fun WelcomeDialog(vm: MainViewModel) {
    var seen by rememberSetting("seenWelcome", false)
    val restore by vm.restoreOffer.collectAsStateWithLifecycle()
    val hasMusic by vm.hasAudioPermission.collectAsStateWithLifecycle()
    // A returning user with a backup sees the restore offer instead; don't greet them as new.
    if (seen || restore != null) return
    val c = Hive.colors
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val pager = rememberPagerState { STEPS.size }

    // Granting music access on its page nudges the walk-through forward on its own, so the yes feels answered.
    LaunchedEffect(hasMusic) {
        if (hasMusic && pager.currentPage == PERMISSION_PAGE) { delay(420); pager.animateScrollToPage(PERMISSION_PAGE + 1, animationSpec = Motion.move()) }
    }

    Dialog(onDismissRequest = { seen = true }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(c.bg, mix(c.accent, c.bg, 0.14f), c.bg))),
        ) {
            val lastPage = pager.currentPage == STEPS.lastIndex
            // Skip sits quietly up top until the final page, where the only way on is the big button.
            if (!lastPage) Box(
                Modifier.align(Alignment.TopEnd).padding(top = 18.dp, end = 10.dp)
                    .clip(HiveShape.pill).clickable { seen = true }.padding(horizontal = 14.dp, vertical = 8.dp),
            ) { Text("Skip", style = HiveText.pill, color = c.textDim) }

            Column(Modifier.fillMaxSize().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth()) { page ->
                    val step = STEPS[page]
                    val offset = (pager.currentPage - page) + pager.currentPageOffsetFraction
                    Column(
                        Modifier.fillMaxSize().padding(bottom = 8.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Illustration(step.icon, offset)
                        Spacer(Modifier.height(40.dp))
                        Text(
                            step.title,
                            style = HiveText.year.copy(fontSize = 27.sp, lineHeight = 32.sp),
                            color = c.text,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.graphicsLayer { translationX = offset * 40.dp.toPx(); alpha = (1f - abs(offset) * 0.8f).coerceIn(0f, 1f) },
                        )
                        Spacer(Modifier.height(14.dp))
                        Text(
                            step.body,
                            style = HiveText.row.copy(lineHeight = 22.sp),
                            color = c.textDim,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.graphicsLayer { translationX = offset * 26.dp.toPx(); alpha = (1f - abs(offset) * 0.9f).coerceIn(0f, 1f) },
                        )
                    }
                }

                Dots(pager.currentPage, STEPS.size)
                Spacer(Modifier.height(22.dp))

                val needMusic = pager.currentPage == PERMISSION_PAGE && !hasMusic
                val label = when {
                    needMusic -> "Allow music access"
                    lastPage -> "Start listening"
                    else -> "Next"
                }
                Cta(label) {
                    when {
                        needMusic -> { haptics.performHapticFeedback(HapticFeedbackType.LongPress); vm.requestAudioPermission() }
                        lastPage -> { haptics.performHapticFeedback(HapticFeedbackType.LongPress); seen = true }
                        else -> scope.launch { pager.animateScrollToPage(pager.currentPage + 1, animationSpec = Motion.move()) }
                    }
                }
                Spacer(Modifier.height(36.dp))
            }
        }
    }
}

/** The floating, breathing emblem for a page: a soft accent halo behind a disc that drifts with the page. */
@Composable
private fun Illustration(icon: ImageVector, offset: Float) {
    val c = Hive.colors
    val inf = rememberInfiniteTransition(label = "float")
    val t by inf.animateFloat(0f, 1f, infiniteRepeatable(tween(2800, easing = Motion.SineInOut33), RepeatMode.Reverse), label = "t")
    Box(
        Modifier.size(168.dp)
            .graphicsLayer { translationX = offset * 70.dp.toPx(); alpha = (1f - abs(offset) * 0.65f).coerceIn(0f, 1f) },
        contentAlignment = Alignment.Center,
    ) {
        // Halo: breathes in scale and brightness so the emblem feels lit from within, not drawn on.
        Box(Modifier.size(168.dp).graphicsLayer {
            val s = 0.86f + t * 0.18f; scaleX = s; scaleY = s; alpha = 0.45f + t * 0.3f
        }.background(Brush.radialGradient(listOf(c.accentGlow, Color.Transparent)), CircleShape))
        // Disc + icon: rises and settles a few pixels, out of phase with the halo.
        Box(
            Modifier.size(104.dp).graphicsLayer { translationY = (0.5f - t) * 16.dp.toPx() }
                .clip(CircleShape).background(mix(c.accent, c.panelStrong, 0.16f)).border(1.dp, mix(c.accent, c.border, 0.3f), CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, tint = c.accent, modifier = Modifier.size(46.dp)) }
    }
}

/** Progress: the current page's dot stretches into a bar and takes the accent; the rest stay quiet. */
@Composable
private fun Dots(current: Int, count: Int) {
    val c = Hive.colors
    Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(count) { i ->
            val on = i == current
            val w by animateDpAsState(if (on) 22.dp else 7.dp, Motion.move(), label = "dot")
            Box(Modifier.height(7.dp).width(w).clip(HiveShape.pill).background(if (on) c.accent else mix(c.textDimmer, c.bg, 0.3f)))
        }
    }
}

/** The one big action per page: accent-filled, dips under the finger, springs back. */
@Composable
private fun Cta(label: String, onClick: () -> Unit) {
    val c = Hive.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.96f else 1f, Motion.move(140), label = "cta")
    Box(
        Modifier.fillMaxWidth().height(54.dp).graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(RoundedCornerShape(16.dp)).background(c.accent)
            .clickable(interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveText.pill.copy(fontSize = 15.sp), color = readableOn(c.accent)) }
}
