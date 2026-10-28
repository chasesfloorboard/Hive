package com.local.hive.mobile.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.border
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
    val toast = LocalToast.current
    var open by remember(job.id) { mutableStateOf(!job.finished) }
    Column(Modifier.fillMaxWidth().clickable { open = !open }.padding(horizontal = 18.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(job.label, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(job.message.ifBlank { job.state }, style = HiveText.small, color = if (job.state == "failed") Failed else c.textDim, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text("${job.doneCount}/${job.songs.size}", style = HiveText.numbers, color = c.textDim)
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
