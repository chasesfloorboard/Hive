package com.local.hive.mobile.ui

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.CrashLog
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import java.text.DateFormat
import java.util.Date

/** The developer menu's switch: on after the version is tapped seven times (Settings › Advanced). */
object DeveloperMode {
    private fun prefs(c: Context) = c.getSharedPreferences("developer", Context.MODE_PRIVATE)
    fun on(c: Context) = prefs(c).getBoolean("on", false)
    fun set(c: Context, on: Boolean) = prefs(c).edit().putBoolean("on", on).apply()
}

private fun mb(bytes: Long) = if (bytes >= 1L shl 30) "%.1f GB".format(bytes / 1073741824.0) else "${bytes / 1_048_576} MB"
private fun at(ms: Long) = if (ms <= 0) "never" else DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

/** This phone's own numbers, crashes and logs. Nothing here is sent anywhere unless shared by hand. */
fun LazyListScope.developerSettings(vm: MainViewModel, onLeave: () -> Unit) {
    item { Section("This phone", "Only this phone's numbers: Hive sends nothing anywhere.") { DevNumbers(vm) } }
    item { Section("Crashes and errors", "Kept on this phone. Tap one to share it.") { DevCrashes() } }
    item { Section("Logs", "") { DevLogs() } }
    item {
        Section("", "") {
            val context = LocalContext.current
            DevRow("Hide the developer menu", "Tap the version seven times to bring it back") { DeveloperMode.set(context, false); onLeave() }
        }
    }
}

@Composable
private fun DevRow(label: String, value: String, onClick: (() -> Unit)? = null) {
    val c = Hive.colors
    Column((if (onClick != null) Modifier.pressable(onClick = onClick) else Modifier).fillMaxWidth().padding(horizontal = 18.dp, vertical = 9.dp)) {
        Text(label, style = HiveText.rowStrong, color = c.text)
        Text(value, style = HiveText.small, color = c.textDim, maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun DevNumbers(vm: MainViewModel) {
    val context = LocalContext.current
    var stats by remember { mutableStateOf<DevStats?>(null) }
    LaunchedEffect(Unit) { stats = runCatching { vm.developerStats() }.getOrNull() }
    val link by vm.link.collectAsStateWithLifecycle()
    val songSync by vm.songSync.collectAsStateWithLifecycle()
    val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).let { "${it.versionName} (${it.longVersionCode})" } }.getOrDefault("?") }
    DevRow("Hive Mobile", "$version on Android ${android.os.Build.VERSION.RELEASE}, ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
    val s = stats
    if (s == null) { DevRow("Library", "Counting…"); return }
    DevRow("Library", "${s.songs} songs (${mb(s.librarySizeBytes)}), ${s.loved} loved, ${if (s.playsTotal >= 0) "${s.playsTotal} plays" else "plays unknown"}")
    DevRow("PC link", if (!link.paired) "Not paired" else "${link.serverName} · ${if (link.live) "live" else "not live"} · last sync ${at(link.lastSyncAt)} · ${link.matchedTracks} of ${link.pcTracks} PC songs matched" + (link.error?.let { " · error: $it" } ?: ""))
    DevRow("Waiting to send", "${s.lovesWaiting} favorites, ${if (s.playsWaiting >= 0) s.playsWaiting else "?"} plays, ${link.waitingOnPc} waiting in Hive on the PC")
    DevRow("Song sync", "Folder: ${s.mirrorFolder} · ${s.mirrorAgreed} files on both sides" + (songSync.message?.let { " · $it" } ?: ""))
    DevRow("Deleted, kept 30 days", "${s.deletedKept} files (${mb(s.deletedKeptBytes)}) in the music folder's hidden \"${com.local.hive.mobile.link.FileMirror.DELETED_FOLDER}\"")
    DevRow("Memory", "${s.memoryUsedMb} MB of ${s.memoryMaxMb} MB")
}

@Composable
private fun DevCrashes() {
    val context = LocalContext.current
    var refresh by remember { mutableIntStateOf(0) }
    val entries = remember(refresh) { CrashLog.entries(context) }
    if (entries.isEmpty()) { DevRow("None", "No crashes or errors recorded."); return }
    entries.take(20).forEach { e ->
        DevRow("${if (e.fatal) "Crash" else "Error"} · ${at(e.at)}", e.title) { CrashLog.share(context, e) }
    }
    DevRow("Clear all", "${entries.size} recorded") { CrashLog.clear(context); refresh++ }
}

/** The end of a log (some grow large): read from its last [max] bytes only, quick enough on a tap. */
private fun lastBytes(f: java.io.File, max: Int): String = runCatching {
    java.io.RandomAccessFile(f, "r").use { r ->
        val start = maxOf(0L, r.length() - max)
        r.seek(start)
        val buf = ByteArray((r.length() - start).toInt())
        r.readFully(buf)
        String(buf, Charsets.UTF_8)
    }
}.getOrDefault("")

@Composable
private fun DevLogs() {
    val context = LocalContext.current
    val dir = context.getExternalFilesDir(null)
    val logs = remember { dir?.listFiles()?.filter { it.isFile && it.name.endsWith(".txt") }?.sortedBy { it.name }.orEmpty() }
    if (logs.isEmpty()) { DevRow("None", "No logs yet."); return }
    logs.forEach { f ->
        DevRow(f.name, "${f.length() / 1024} KB · ${at(f.lastModified())}") {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, "Hive Mobile ${f.name}")
                .putExtra(Intent.EXTRA_TEXT, lastBytes(f, 60_000))
            context.startActivity(Intent.createChooser(send, "Share the log").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
