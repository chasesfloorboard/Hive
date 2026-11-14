package com.local.hive.mobile.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.border
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.background
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.soulseek.DownloadJob
import com.local.hive.mobile.soulseek.SoulseekClient
import com.local.hive.mobile.soulseek.SoulseekRequest
import com.local.hive.mobile.soulseek.SoulseekSettings
import com.local.hive.mobile.soulseek.SoulseekWorker
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import kotlinx.coroutines.launch

private val Failed = Color(0xFFFF8A8A)

/**
 * An album page's download button: Download, then the album's progress
 * ("3/11" in a ring) while it comes in, then a tick. Tapping it while
 * downloading (or after) shows the downloads. Not signed in to Soulseek yet:
 * it asks for the account once, then starts.
 */
@Composable
fun DownloadButton(artist: String, album: String, request: () -> SoulseekRequest, onToast: (String) -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    val app = context.applicationContext as HiveApp
    val jobs by app.downloads.jobs.collectAsStateWithLifecycle()
    val job = jobs.firstOrNull { it.artist == artist && it.album == album }
    var signIn by remember { mutableStateOf(false) }
    var list by remember { mutableStateOf(false) }
    fun start() {
        SoulseekWorker.enqueue(context, request())
        onToast("Downloading $album to ${SoulseekSettings(context).where(context)}")
    }
    when {
        job != null && !job.finished -> Box(Modifier.size(46.dp).clip(CircleShape).clickable { list = true }, contentAlignment = Alignment.Center) {
            if (job.state == "downloading") CircularProgressIndicator(progress = { job.progress }, Modifier.size(46.dp), color = c.accent, trackColor = c.border, strokeWidth = 3.dp)
            else CircularProgressIndicator(Modifier.size(46.dp), color = c.accent, trackColor = c.border, strokeWidth = 3.dp)
            Text("${job.doneCount}/${job.songs.size}", style = HiveText.small, color = c.text)
        }
        job != null && job.state == "done" -> ControlButton(Icons.Rounded.Check, "Downloaded", { list = true }, size = 46.dp, tint = c.accent)
        else -> ControlButton(Icons.Rounded.Download, "Download", {
            if (SoulseekSettings(context).configured) start() else signIn = true
        }, size = 46.dp)
    }
    if (signIn) SoulseekSignInDialog(onDismiss = { signIn = false }, onSignedIn = { signIn = false; start() })
    if (list) DownloadsSheet(onDismiss = { list = false })
}

/** Signing in to Soulseek, once, when the first download is asked for. */
@Composable
fun SoulseekSignInDialog(onDismiss: () -> Unit, onSignedIn: () -> Unit, confirm: String = "Sign in and download") {
    val c = Hive.colors
    val context = LocalContext.current
    val settings = remember { SoulseekSettings(context) }
    var user by remember { mutableStateOf(settings.username) }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    HiveDialog({ if (!busy) onDismiss() }, spacing = 10.dp) {
            Text("Sign in to Soulseek", style = HiveText.year, color = c.text)
            Text("Hive downloads with your Soulseek account (the one Seeker uses works). It shares nothing, and the account stays on this phone. Soulseek signs it out wherever else it's in use while Hive downloads.", style = HiveText.small, color = c.textDim)
            HiveField(user, { user = it }, "Username")
            HiveField(pass, { pass = it }, "Password", type = KeyboardType.Password)
            error?.let { Text(it, style = HiveText.small, color = Failed) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                HiveButton(if (busy) "Signing in…" else confirm, primary = true, enabled = !busy && user.isNotBlank() && pass.isNotBlank()) {
                    busy = true; error = null
                    scope.launch {
                        val client = SoulseekClient(user.trim(), pass)
                        // Closed however this ends (even the dialog leaving mid-sign-in), so no session lingers.
                        val result = try { runCatching { client.login() } } finally { client.close() }
                        busy = false
                        result.onSuccess { settings.username = user; settings.password = pass; onSignedIn() }
                            .onFailure { error = it.message ?: "Couldn't reach Soulseek" }
                    }
                }
            }
    }
}



/** The downloads: each album's songs as they come in (waiting, %, done, or not found), the latest first. */
@Composable
fun DownloadsSheet(onDismiss: () -> Unit) {
    val c = Hive.colors
    val app = LocalContext.current.applicationContext as HiveApp
    val jobs by app.downloads.jobs.collectAsStateWithLifecycle()
    HiveDialog(onDismiss, Modifier.heightIn(max = 620.dp), padding = PaddingValues(vertical = 16.dp), spacing = 0.dp) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Downloads", style = HiveText.year, color = c.text, modifier = Modifier.weight(1f))
                if (jobs.any { it.finished }) Text("Clear finished", style = HiveText.small, color = c.accent, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { app.downloads.clearFinished() }.padding(6.dp))
            }
            if (jobs.isEmpty()) Text("Nothing downloaded yet. The download button on an Apple Music or Spotify album starts one.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(18.dp))
            LazyColumn(Modifier.fillMaxWidth()) {
                items(jobs, key = { it.id }) { job -> DownloadCard(job) }
            }
    }
}

@Composable
private fun DownloadCard(job: DownloadJob) {
    val c = Hive.colors
    val context = LocalContext.current
    val app = context.applicationContext as HiveApp
    val toast = LocalToast.current
    var open by remember(job.id) { mutableStateOf(!job.finished) }
    Column(Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = 18.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(job.label, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(job.message.ifBlank { job.state }, style = HiveText.small, color = if (job.state == "failed") Failed else c.textDim, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text("${job.doneCount}/${job.songs.size}", style = HiveText.numbers, color = c.textDim)
            if (!job.finished) Box(Modifier.padding(start = 6.dp).size(40.dp).clip(CircleShape).clickable(onClickLabel = "Cancel") { app.downloads.cancel(job.id); toast("Cancelled ${job.label}") }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Close, "Cancel downloading ${job.label}", tint = c.textDim, modifier = Modifier.size(20.dp))
            }
        }
        if (!job.finished) {
            if (job.state == "downloading") LinearProgressIndicator(progress = { job.progress }, Modifier.fillMaxWidth().padding(top = 4.dp), color = c.accent, trackColor = c.border)
            else LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp), color = c.accent, trackColor = c.border)
        }
        if (open) job.songs.forEachIndexed { i, s ->
            // A song nobody had: tap to look for it in Seeker.
            val find = if (s.state == "missing") Modifier.clip(RoundedCornerShape(8.dp)).clickable {
                if (!com.local.hive.mobile.stream.Seeker.search(context, com.local.hive.mobile.stream.Seeker.albumQuery(job.artist, s.title))) toast("Seeker isn't installed")
            } else Modifier
            Row(Modifier.fillMaxWidth().then(find).padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("${i + 1}", style = HiveText.numbers, color = c.textDimmer, modifier = Modifier.width(26.dp))
                Text(s.title, style = HiveText.rowSub, color = if (s.state == "missing") c.textDimmer else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Box(Modifier.width(44.dp), contentAlignment = Alignment.CenterEnd) {
                    when (s.state) {
                        "done" -> Icon(Icons.Rounded.Check, "Downloaded", tint = c.accent, modifier = Modifier.size(16.dp))
                        "downloading" -> Text("${s.percent}%", style = HiveText.numbers, color = c.accent)
                        "missing" -> Icon(Icons.Rounded.Close, "Not found: tap to find it in Seeker", tint = Failed, modifier = Modifier.size(16.dp))
                        else -> Icon(Icons.Rounded.RadioButtonUnchecked, "Waiting", tint = c.textDimmer, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
    }
}

/**
 * A small floating bubble while Soulseek downloads are coming in: a ring for
 * how far along they are, an arrow that keeps dropping so it clearly reads as
 * busy, and a count when more than one album is coming. It pops in from
 * nothing, shows a tick for a moment when the last one finishes, then goes.
 * Tapping it opens the download queue.
 */
@Composable
fun DownloadBubble(modifier: Modifier = Modifier, hidden: Boolean = false) {
    val c = Hive.colors
    val app = LocalContext.current.applicationContext as HiveApp
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val jobs by app.downloads.jobs.collectAsStateWithLifecycle()
    val active = jobs.filter { !it.finished }
    var justFinished by remember { mutableStateOf(false) }
    var wasActive by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(active.isNotEmpty()) {
        if (active.isNotEmpty()) { wasActive = true; justFinished = false }
        else if (wasActive) { wasActive = false; justFinished = true; kotlinx.coroutines.delay(2_400); justFinished = false }
    }
    var list by remember { mutableStateOf(false) }
    val visible = !hidden && (active.isNotEmpty() || justFinished)
    androidx.compose.animation.AnimatedVisibility(
        visible, modifier,
        enter = androidx.compose.animation.scaleIn(androidx.compose.animation.core.spring(dampingRatio = 0.55f, stiffness = 420f), initialScale = 0.3f) + androidx.compose.animation.fadeIn(androidx.compose.animation.core.tween(140)),
        exit = androidx.compose.animation.scaleOut(androidx.compose.animation.core.tween(220), targetScale = 0.5f) + androidx.compose.animation.fadeOut(androidx.compose.animation.core.tween(200)),
    ) {
        val progress = if (active.isEmpty()) 1f else active.map { it.progress }.average().toFloat()
        val shown by androidx.compose.animation.core.animateFloatAsState(progress, androidx.compose.animation.core.spring(stiffness = 120f), label = "dl-progress")
        val loop = androidx.compose.animation.core.rememberInfiniteTransition(label = "dl-loop")
        val drop by loop.animateFloat(0f, 1f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween<Float>(2000, easing = androidx.compose.animation.core.LinearEasing)), label = "dl-drop")
        val spin by loop.animateFloat(0f, 360f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween<Float>(1600, easing = androidx.compose.animation.core.LinearEasing)), label = "dl-spin")
        val searching = active.isNotEmpty() && active.none { it.state == "downloading" }
        Box(Modifier.size(64.dp)) {
        Box(
            Modifier.size(58.dp).align(Alignment.Center)
                .androidxShadow(c.accentGlow)
                .clip(CircleShape)
                .background(com.local.hive.mobile.ui.theme.mix(c.accent, c.control, 0.10f).copy(alpha = 0.97f))
                .border(1.dp, com.local.hive.mobile.ui.theme.hiveGlassBorder(), CircleShape)
                .clickable(onClickLabel = "Open downloads") { haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove); list = true }
                .semantics { contentDescription = if (active.isEmpty()) "Downloads finished" else "Downloading ${active.size} ${if (active.size == 1) "album" else "albums"}, ${(progress * 100).toInt()}%. Open downloads" },
            contentAlignment = Alignment.Center,
        ) {
            androidx.compose.foundation.Canvas(Modifier.size(50.dp)) {
                val stroke = androidx.compose.ui.graphics.drawscope.Stroke(width = 3.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round)
                drawArc(c.border, 0f, 360f, false, style = stroke)
                if (searching) drawArc(c.accent, spin - 90f, 70f, false, style = stroke)
                else drawArc(c.accent, -90f, 360f * shown.coerceIn(0.02f, 1f), false, style = stroke)
            }
            if (justFinished && active.isEmpty()) {
                Icon(Icons.Rounded.Check, null, tint = c.accent, modifier = Modifier.size(26.dp))
            } else {
                // The arrow rests in the middle, slips down a little as it fades, then fades back in where it was.
                val ease = androidx.compose.animation.core.FastOutSlowInEasing
                val (y, alpha) = when {
                    drop < 0.42f -> 0f to 1f
                    drop < 0.75f -> ease.transform((drop - 0.42f) / 0.33f).let { it * 3.5f to 1f - it }
                    else -> ease.transform((drop - 0.75f) / 0.25f).let { -1.5f * (1f - it) to it }
                }
                Icon(Icons.Rounded.Download, null, tint = c.text, modifier = Modifier.size(24.dp).graphicsLayer { translationY = y.dp.toPx(); this.alpha = alpha })
            }
        }
            if (active.size > 1) Box(
                Modifier.align(Alignment.TopEnd).size(22.dp).shadow(4.dp, CircleShape).clip(CircleShape).background(c.accent),
                contentAlignment = Alignment.Center,
            ) { Text("${active.size}", style = HiveText.small.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.bg) }
        }
    }
    if (list) DownloadsSheet(onDismiss = { list = false })
}

private fun Modifier.androidxShadow(glow: Color) = this.shadow(16.dp, CircleShape, ambientColor = glow, spotColor = glow)
