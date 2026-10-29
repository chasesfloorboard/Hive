package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.launch

/** Settings laid out as in Hive: titled sections with a description, label-and-hint rows with the control on the right. */
@Composable
fun SettingsScreen(vm: MainViewModel, bottomPadding: Dp, onOpenEqualiser: () -> Unit, onBack: () -> Unit) {
    val link by vm.link.collectAsStateWithLifecycle()
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    val scanning by vm.scanning.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 8.dp, end = 8.dp, bottom = bottomPadding + 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("Settings", style = HiveText.viewTitle, color = Hive.colors.text, modifier = Modifier.padding(start = 12.dp, top = 4.dp, bottom = 6.dp)) }
            item {
                Section("Hive on your PC", "Over Wi-Fi, or by USB cable with USB debugging on. Your PC's Favorites and plays come here; what you do here waits in Hive on the PC until you apply it there (Settings › Connections).") {
                    if (link.paired) PairedRows(vm) else PairRows(vm)
                }
            }
            item {
                Section("Spotify", "Sign in to see your playlists and Liked Songs, and to search Spotify. Shared links work without signing in.") { SpotifyRows(vm) }
            }
            item {
                Section("Soulseek", "Download albums and songs from Apple Music and Spotify pages (the download button). Hive shares nothing and saves where your music is (below); song sync takes them to your PC on Wi-Fi.") { SoulseekRows() }
            }
            item {
                Section("Sound", "Hive's equaliser runs inside the player, so it works on speakers, headphones and Bluetooth alike.") {
                    val eq by vm.equaliser.state.collectAsStateWithLifecycle()
                    SettingRow("Equaliser", if (eq.enabled) eq.preset else "Off") { HiveButton("Open") { onOpenEqualiser() } }
                    // One switch on the phone: on, it levels as Hive's "Smart" does (album gain while an
                    // album plays in order) and never past a song's peak. The PC keeps the finer choices.
                    val levelling = eq.replayGain != "off"
                    SettingRow("Even out loudness", "Songs play at a similar volume, from their ReplayGain tags. Albums keep their own quiet and loud parts.") {
                        HiveToggle(listOf("Off", "On"), if (levelling) 1 else 0, { i -> vm.equaliser.update { it.copy(replayGain = if (i == 1) "smart" else "off", clippingGuard = true) } })
                    }
                    // Hive's crossfade: the end of one song fades into the next, as on the PC.
                    val fades = listOf(0, 2_000, 4_000, 6_000, 8_000, 12_000)
                    SettingRow("Crossfade", if (eq.crossfadeMs == 0) "Off: songs follow each other without a gap." else "The last ${eq.crossfadeMs / 1000} seconds of a song fade into the next.") {}
                    HiveToggle(listOf("Off", "2 s", "4 s", "6 s", "8 s", "12 s"), fades.indexOf(fades.lastOrNull { it <= eq.crossfadeMs } ?: 0), { i -> vm.equaliser.update { it.copy(crossfadeMs = fades[i]) } }, Modifier.padding(horizontal = 16.dp))
                    if (eq.crossfadeMs > 0) {
                        SettingRow("Not within an album", "Songs of the same album play straight on, gapless.") {
                            HiveToggle(listOf("Off", "On"), if (eq.crossfadeExcludeAlbums) 1 else 0, { i -> vm.equaliser.update { it.copy(crossfadeExcludeAlbums = i == 1) } })
                        }
                        SettingRow("Crossfade when skipping", "Skipping to the next song fades too.") {
                            HiveToggle(listOf("Off", "On"), if (eq.crossfadeOnSkip) 1 else 0, { i -> vm.equaliser.update { it.copy(crossfadeOnSkip = i == 1) } })
                        }
                    }
                }
            }
            item {
                Section("Lock screen", "Hive's player over the lock screen while music plays, as Samsung Music has it. Swipe up to unlock.") {
                    val context = androidx.compose.ui.platform.LocalContext.current
                    var on by remember { mutableStateOf(com.local.hive.mobile.LockPlayerActivity.enabled(context)) }
                    // Coming back from Android's permission page, the switch reflects what was allowed.
                    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current
                    var permitted by remember { mutableStateOf(com.local.hive.mobile.LockPlayerActivity.permitted(context)) }
                    androidx.compose.runtime.DisposableEffect(lifecycle) {
                        val o = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) permitted = com.local.hive.mobile.LockPlayerActivity.permitted(context) }
                        lifecycle.lifecycle.addObserver(o); onDispose { lifecycle.lifecycle.removeObserver(o) }
                    }
                    SettingRow("Show on lock screen", if (on && !permitted) "Allow “Display over other apps” for Hive so Android lets it appear." else "Opens when the screen turns off with music playing.") {
                        HiveToggle(listOf("Off", "On"), if (on && permitted) 1 else 0, { i ->
                            on = i == 1
                            com.local.hive.mobile.LockPlayerActivity.setEnabled(context, on)
                            if (on && !permitted) context.startActivity(android.content.Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:${context.packageName}")))
                        })
                    }
                }
            }
            item {
                Section("Scrobbling", "Report what you play to ListenBrainz or Last.fm, as Hive on your PC does. Listens made offline go once you're back.") { ScrobbleRows(vm) }
            }
            item {
                Section("Library", "The music stored on this phone, kept up to date as files change.") {
                    SettingRow(countOf(tracks.size, "track"), "Read from this phone's music.") {
                        HiveButton(if (scanning) "Scanning…" else "Rescan", enabled = !scanning) { vm.rescan() }
                    }
                    LibraryInfoRows(vm)
                }
            }
            item {
                Section("Appearance", "Your Hive theme from the PC, Hive Mobile's own colours, or Custom with a background and an accent you pick. The backdrop follows the playing cover; the accent is the theme's own, or the cover's (Accent).") { ThemeRows(vm) }
            }
            item {
                val context = androidx.compose.ui.platform.LocalContext.current
                val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "" }
                Section("About", "") { SettingRow("Hive Mobile", "Version $version · Inter is licensed under the SIL Open Font License.") {} }
            }
        }
    }
}

@Composable
private fun Section(title: String, description: String, content: @Composable () -> Unit) {
    val c = Hive.colors
    Column(Modifier.fillMaxWidth().hiveGlass(HiveShape.panel).padding(vertical = 14.dp)) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = HiveText.year, color = c.text)
            if (description.isNotBlank()) Text(description, style = HiveText.small, color = c.textDim)
        }
        content()
    }
}

@Composable
private fun SettingRow(label: String, hint: String, control: @Composable () -> Unit) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = HiveText.rowStrong, color = c.text)
            if (hint.isNotBlank()) Text(hint, style = HiveText.small, color = c.textDim)
        }
        control()
    }
}


@Composable
private fun PairedRows(vm: MainViewModel) {
    val c = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    val state = when {
        link.syncing -> "Syncing…"
        link.live -> "Connected" + when { link.host == com.local.hive.mobile.link.HiveLinkClient.USB_HOST -> " · by USB"; link.host.isNotBlank() -> " · ${link.host}"; else -> "" }
        else -> "Not connected right now"
    }
    SettingRow(link.serverName, state) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(if (link.live) Color(0xFF7BE0A0) else c.textDimmer))
    }
    val detail = buildList {
        if (link.pcTracks > 0) add("%,d of this phone's songs matched to Hive's %,d".format(link.matchedTracks, link.pcTracks))
        if (link.pendingChanges > 0) add("${link.pendingChanges} changes not sent yet")
        if (link.waitingOnPc > 0) add("%,d changes and plays waiting for you in Hive on the PC".format(link.waitingOnPc))
        if (link.lastSyncAt > 0) add("Synced ${DateUtils.getRelativeTimeSpanString(link.lastSyncAt)}")
    }.joinToString("\n")
    SettingRow("Favorites sync", detail) { HiveButton(if (link.syncing) "Syncing…" else "Sync now", enabled = !link.syncing, primary = true) { vm.syncNow() } }
    link.error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    SongSyncRows(vm)
    AutoConnectRow(vm)
    SettingRow("Unpair this phone", "Stops syncing. Favorites already here stay.") { HiveButton("Unpair") { vm.unpair() } }
}

/**
 * Song sync: songs on one side only are copied to the other on Wi-Fi. The
 * first time, the user sees what would be copied before anything moves.
 */
@Composable
private fun SongSyncRows(vm: MainViewModel) {
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val on by vm.songSyncOn.collectAsStateWithLifecycle()
    val s by vm.songSync.collectAsStateWithLifecycle()
    fun size(bytes: Long) = android.text.format.Formatter.formatShortFileSize(context, bytes)
    // With All files access, song sync keeps the music folders one to one, file for file (FileMirror).
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current
    var mirrors by remember { mutableStateOf(com.local.hive.mobile.link.FileMirror.available(context)) }
    androidx.compose.runtime.DisposableEffect(lifecycle) {
        val o = androidx.lifecycle.LifecycleEventObserver { _, e -> if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) mirrors = com.local.hive.mobile.link.FileMirror.available(context) }
        lifecycle.lifecycle.addObserver(o); onDispose { lifecycle.lifecycle.removeObserver(o) }
    }
    val unit = if (mirrors) "file" else "song"
    fun songs(n: Int) = if (n == 1) "1 $unit" else "%,d ${unit}s".format(n)
    val plan = s.plan
    val planText = plan?.let { p ->
        // Nothing to copy also covers songs deleted on one side on purpose.
        if (p.toPhone == 0 && p.toPc == 0) "Up to date: nothing to copy."
        else buildList {
            if (p.toPhone > 0) add("${songs(p.toPhone)} (${size(p.bytesToPhone)}) from the PC to this phone")
            if (p.toPc > 0) add("${songs(p.toPc)} (${size(p.bytesToPc)}) from this phone to the PC" + if (p.pcTakesSongs) "" else " — Hive isn't taking songs right now (Settings › Connections on the PC)")
        }.joinToString("\n")
    }
    if (!on) {
        // What would be copied is worked out as soon as this shows, so the start button is right there.
        androidx.compose.runtime.LaunchedEffect(Unit) { if (s.plan == null && !s.checking) vm.checkSongs() }
        SettingRow("Song sync", "Copies songs that are only on the phone or only on the PC to the other, on Wi-Fi. Songs you delete aren't copied back.") {
            if (s.checking || plan == null) HiveButton(if (s.checking) "Checking…" else "Check", enabled = !s.checking) { vm.checkSongs() }
            else if (plan.toPhone > 0 || plan.toPc > 0) HiveButton("Start song sync", primary = true) { vm.setSongSync(true) }
        }
        if (planText != null) {
            Text(planText, style = HiveText.small, color = c.textDim, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
        }
    } else {
        val status = when {
            s.running && s.total > 0 -> "Copying ${s.done + 1} of ${s.total}" + if (s.current.isNotBlank()) "\n${s.current}" else ""
            s.running || s.checking -> "Checking…"
            planText != null -> planText + if ((plan?.toPhone ?: 0) + (plan?.toPc ?: 0) > 0) "\nWaiting for Wi-Fi" else ""
            else -> "On. Songs copy over Wi-Fi when Hive is open on the PC."
        } + if (s.failed > 0) "\n${s.failed} couldn't be copied; they'll be tried again." else ""
        SettingRow("Song sync", status) { HiveButton("Turn off") { vm.setSongSync(false) } }
    }
    s.message?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    if (android.os.Build.VERSION.SDK_INT >= 30) SettingRow(
        "Keep files one to one",
        if (mirrors) "On: this phone's music folder and the PC's hold the same files, in the same folders. A file changed on one side is copied to the other; anything replaced is kept in Hive's Deleted songs on the PC."
        else "Allow “All files access” for Hive and song sync keeps this phone's music folder exactly like the PC's: every file, in the same folders, updated when it changes on either side.",
    ) {
        if (!mirrors) HiveButton("Allow") {
            runCatching { context.startActivity(android.content.Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, android.net.Uri.parse("package:${context.packageName}"))) }
        }
    }
    // Songs deleted on one side since they were on both: the user decides what happens on the other.
    val gone by vm.deletions.collectAsStateWithLifecycle()
    if (gone.count > 0) SettingRow("Deleted songs", listOfNotNull(
        gone.fromPc.size.takeIf { it > 0 }?.let { "${songs(it)} deleted on your PC" },
        gone.fromPhone.size.takeIf { it > 0 }?.let { "${songs(it)} deleted on this phone" },
    ).joinToString(" · ")) { HiveButton("Review", primary = true) { vm.openDeletions.value = true } }
}

/** "Connect automatically": Hive opening on the PC's Wi-Fi finds it and connects; the PC allows this phone once. */
@Composable
private fun AutoConnectRow(vm: MainViewModel) {
    val on by vm.autoConnect.collectAsStateWithLifecycle()
    SettingRow("Connect automatically", "When Hive opens on the same Wi-Fi as your PC, it finds Hive there and connects. The first time, Hive on the PC asks you to allow this phone.") {
        HiveToggle(listOf("Off", "On"), if (on) 1 else 0, { i -> vm.setAutoConnect(i == 1) })
    }
}

@Composable
private fun PairRows(vm: MainViewModel) {
    val c = Hive.colors
    val found by vm.discovered.collectAsStateWithLifecycle()
    val discovering by vm.discovering.collectAsStateWithLifecycle()
    val busy by vm.pairing.collectAsStateWithLifecycle()
    val error by vm.pairError.collectAsStateWithLifecycle()
    val linkError by vm.link.collectAsStateWithLifecycle()
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf(HiveLinkClient.DEFAULT_PORT.toString()) }
    var code by remember { mutableStateOf("") }

    AutoConnectRow(vm)
    linkError.connecting?.let { Text(it, style = HiveText.small, color = c.accent, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    SettingRow("Or pair with a code", "On the PC: Settings › Connections › Hive Mobile › Pair phone.") {}
    SettingRow("Find Hive on this Wi-Fi", "") {
        if (discovering) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.accent)
        else HiveButton("Search") { vm.discover() }
    }
    found.forEach { hive ->
        val selected = host == hive.host
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp).clip(HiveShape.row).background(if (selected) c.accentSoft.copy(alpha = 0.3f) else Color.Transparent)
                .clickable { host = hive.host; port = hive.port.toString() }.padding(horizontal = 10.dp, vertical = 10.dp),
        ) {
            Column {
                Text(hive.name, style = HiveText.rowStrong, color = c.text)
                Text("${hive.host}:${hive.port}", style = HiveText.small, color = c.textDim)
            }
        }
    }
    Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        HiveField(host, { host = it }, "PC address", type = KeyboardType.Uri, modifier = Modifier.weight(1f))
        HiveField(port, { port = it.filter(Char::isDigit) }, "Port", type = KeyboardType.Number, modifier = Modifier.width(96.dp))
    }
    Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        HiveField(code, { code = it.filter(Char::isDigit).take(6) }, "Pairing code", type = KeyboardType.NumberPassword, modifier = Modifier.fillMaxWidth())
    }
    (error ?: linkError.error)?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
        HiveButton(if (busy) "Pairing…" else "Pair", enabled = !busy && host.isNotBlank() && code.length == 6, primary = true) {
            vm.pair(host, port.toIntOrNull() ?: HiveLinkClient.DEFAULT_PORT, code)
        }
    }
}


/** The Soulseek account (signing in checks it with the server, in the same window the download button opens), the format, and where downloads go. */
@Composable
private fun SoulseekRows() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val settings = remember { com.local.hive.mobile.soulseek.SoulseekSettings(context) }
    var signedIn by remember { mutableStateOf(settings.configured) }
    var signIn by remember { mutableStateOf(false) }
    var quality by remember { mutableStateOf(settings.quality) }
    if (signedIn) SettingRow("Signed in as ${settings.username}", "Downloads use this account. Seeker on the same account is signed out while Hive downloads.") {
        HiveButton("Sign out") { settings.password = ""; signedIn = false }
    } else SettingRow("Not signed in", "Your Soulseek account (the one Seeker uses works).") { HiveButton("Sign in", primary = true) { signIn = true } }
    if (signIn) SoulseekSignInDialog(onDismiss = { signIn = false }, onSignedIn = { signIn = false; signedIn = true }, confirm = "Sign in")
    SettingRow("Prefer", if (quality == com.local.hive.mobile.soulseek.Quality.Lossless) "FLAC when someone shares it, else MP3 320." else "MP3 320 (smaller), else FLAC.") {
        HiveToggle(listOf("FLAC", "MP3"), quality.ordinal, { i -> quality = com.local.hive.mobile.soulseek.Quality.entries[i]; settings.quality = quality })
    }
    // Where downloads go: the phone or the SD card, into Music/<folder>/<artist>/<album>.
    val storages = remember { com.local.hive.mobile.soulseek.SoulseekSettings.storages(context) }
    var volume by remember { mutableStateOf(settings.volumeNow(context)) }
    var folder by remember { mutableStateOf(settings.folder) }
    SettingRow("Save to", if (storages.size > 1) "Downloads go on ${storages.firstOrNull { it.first == volume }?.second ?: "the phone"}." else "This phone (no SD card in).") {
        if (storages.size > 1) HiveToggle(storages.map { it.second }, storages.indexOfFirst { it.first == volume }.coerceAtLeast(0), { i -> volume = storages[i].first; settings.volume = volume })
    }
    Column(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        HiveField(folder, { folder = it; settings.folder = it }, "Folder in Music (blank: Music itself)", type = KeyboardType.Text, modifier = Modifier.fillMaxWidth())
        Text("Saved as Music/${folder.trim().trim('/').let { if (it.isBlank()) "" else "$it/" }}Artist/Album", style = HiveText.small, color = Hive.colors.textDim, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
    }
    var list by remember { mutableStateOf(false) }
    SettingRow("Downloads", "Albums coming in, song by song, and the latest done.") { HiveButton("Open") { list = true } }
    if (list) DownloadsSheet(onDismiss = { list = false })
}

@Composable
private fun SpotifyRows(vm: MainViewModel) {
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val user by vm.spotifyUser.collectAsStateWithLifecycle()
    var clientId by remember(user.clientId) { mutableStateOf(user.clientId) }
    if (user.signedIn) {
        SettingRow("Signed in as ${user.name.ifBlank { "you" }}", "Your playlists and Liked Songs appear on the Spotify page.") { HiveButton("Sign out") { vm.spotifyAccount.signOut() } }
    } else {
        Text(
            "Once: create an app at developer.spotify.com/dashboard, add the redirect URI ${com.local.hive.mobile.stream.SpotifyAccount.REDIRECT}, add your Spotify account under User Management, then paste the app's Client ID here.",
            style = HiveText.small, color = c.textDim, modifier = Modifier.padding(horizontal = 18.dp, vertical = 6.dp),
        )
        Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
            HiveField(clientId, { clientId = it.trim() }, "Client ID", type = KeyboardType.Ascii, modifier = Modifier.fillMaxWidth())
        }
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
            HiveButton("Sign in with Spotify", enabled = clientId.length >= 16, primary = true) {
                vm.spotifyAccount.setClientId(clientId)
                runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, vm.spotifyAccount.authorizeUrl())) }
            }
        }
    }
    user.error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
}

@Composable
private fun ThemeRows(vm: MainViewModel) {
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val current by vm.themeName.collectAsStateWithLifecycle()
    var note by remember { mutableStateOf<String?>(null) }
    val packs by vm.themePacks.collectAsStateWithLifecycle()
    val importer = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val name = uri.lastPathSegment?.substringAfterLast('/')?.substringBeforeLast('.') ?: "Imported theme"
        val pack = runCatching { context.contentResolver.openInputStream(uri)?.bufferedReader()?.readText() }.getOrNull()?.let { com.local.hive.mobile.ui.theme.ThemePack.parse(it, name) }
        if (pack == null) note = "That file isn't a Hive theme." else { vm.applyTheme(pack); note = null }
    }
    // Two rows of themes, side-scrolling; Custom opens its colour picker.
    var customizing by remember { mutableStateOf(false) }
    androidx.compose.foundation.lazy.grid.LazyHorizontalGrid(
        androidx.compose.foundation.lazy.grid.GridCells.Fixed(2), Modifier.fillMaxWidth().height(210.dp),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(packs.size) { i ->
            val pack = packs[i]
            val custom = pack.name == com.local.hive.mobile.ui.theme.ThemeStore.CUSTOM
            // Custom comes back as last saved; tapped again (it's on), its colours open to change.
            ThemeSwatch(pack, pack.name == current, editable = custom) {
                when { !custom -> vm.applyTheme(pack); pack.name == current -> customizing = true; else -> vm.themes.applyCustom() }
            }
        }
    }
    if (customizing) CustomThemeDialog(vm) { customizing = false }
    val fromCover by vm.themes.accentFromCover.collectAsStateWithLifecycle()
    SettingRow("Accent", if (fromCover) "Taken from the playing song's cover." else "The theme's own colour.") {
        HiveToggle(listOf("Theme", "Cover"), if (fromCover) 1 else 0, { i -> vm.themes.setAccentFromCover(i == 1) })
    }
    ScheduleRows(vm, packs.map { it.name })
    SettingRow("Import a theme", "A .hive-theme from Hive on your PC, or a CSS file of Hive's variables.") {
        HiveButton("Import") { importer.launch(arrayOf("*/*")) }
    }
    note?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp)) }
}

/** Scheduled theme: one theme by day, another by night; either may be Random (a new one at each switch). */
@Composable
private fun ScheduleRows(vm: MainViewModel, names: List<String>) {
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val s by vm.themes.schedule.collectAsStateWithLifecycle()
    var picking by remember { mutableStateOf<Boolean?>(null) } // true: day theme, false: night theme
    fun set(next: com.local.hive.mobile.ui.theme.ThemeSchedule) = vm.themes.setSchedule(next)
    fun time(value: String, onPick: (String) -> Unit) {
        val m = com.local.hive.mobile.ui.theme.ThemeSchedule.minutesOf(value) ?: 0
        android.app.TimePickerDialog(context, { _, h, min -> onPick("%02d:%02d".format(h, min)) }, m / 60, m % 60, android.text.format.DateFormat.is24HourFormat(context)).show()
    }
    fun shown(hhmm: String): String {
        val m = com.local.hive.mobile.ui.theme.ThemeSchedule.minutesOf(hhmm) ?: return hhmm
        return java.time.LocalTime.of(m / 60, m % 60).format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT))
    }
    SettingRow("Scheduled theme", if (s.enabled) "Switches by itself at the times below." else "One theme by day and another by night.") {
        HiveToggle(listOf("Off", "On"), if (s.enabled) 1 else 0, { i -> set(s.copy(enabled = i == 1)) })
    }
    if (!s.enabled) return
    SettingRow("Day starts", "") { HiveButton(shown(s.dayStart)) { time(s.dayStart) { set(s.copy(dayStart = it)) } } }
    SettingRow("Day theme", if (s.dayTheme == com.local.hive.mobile.ui.theme.ThemeSchedule.RANDOM) "A different theme each morning." else "") { HiveButton(s.dayTheme) { picking = true } }
    SettingRow("Night starts", "") { HiveButton(shown(s.nightStart)) { time(s.nightStart) { set(s.copy(nightStart = it)) } } }
    SettingRow("Night theme", if (s.nightTheme == com.local.hive.mobile.ui.theme.ThemeSchedule.RANDOM) "A different theme each evening." else "") { HiveButton(s.nightTheme) { picking = false } }
    picking?.let { day ->
        HiveDialog({ picking = null }, padding = PaddingValues(10.dp), spacing = 0.dp) {
                Text(if (day) "Day theme" else "Night theme", style = HiveText.year, color = c.text, modifier = Modifier.padding(10.dp))
                androidx.compose.foundation.lazy.LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(listOf(com.local.hive.mobile.ui.theme.ThemeSchedule.RANDOM) + names) { name ->
                        val chosen = name == (if (day) s.dayTheme else s.nightTheme)
                        Text(if (name == com.local.hive.mobile.ui.theme.ThemeSchedule.RANDOM) "Random (a new one each time)" else name,
                            style = HiveText.row, color = if (chosen) c.accent else c.text,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable {
                                set(if (day) s.copy(dayTheme = name) else s.copy(nightTheme = name)); picking = null
                            }.padding(horizontal = 12.dp, vertical = 12.dp))
                    }
                }
        }
    }
}

/** A theme as a little window: its background, a panel and its accent. */
@Composable
private fun ThemeSwatch(pack: com.local.hive.mobile.ui.theme.ThemePack, selected: Boolean, editable: Boolean = false, onClick: () -> Unit) {
    val c = Hive.colors
    val t = remember(pack) { pack.colors }
    Column(Modifier.width(96.dp).clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(96.dp, 70.dp).clip(RoundedCornerShape(14.dp)).background(t.bg)
                .border(if (selected) 2.dp else 1.dp, if (selected) c.accent else c.border, RoundedCornerShape(14.dp)).padding(10.dp),
        ) {
            Box(Modifier.fillMaxWidth().height(22.dp).clip(RoundedCornerShape(6.dp)).background(t.panelStrong.copy(alpha = 1f)).border(1.dp, t.border, RoundedCornerShape(6.dp)))
            Box(Modifier.align(Alignment.BottomStart).size(22.dp).clip(CircleShape).background(t.accent))
            Box(Modifier.align(Alignment.BottomEnd).width(36.dp).height(6.dp).clip(RoundedCornerShape(3.dp)).background(t.textDim))
            // Custom shows it can be changed.
            if (editable) Box(Modifier.align(Alignment.TopEnd).padding(top = 2.dp).size(18.dp).clip(CircleShape).background(t.accent), contentAlignment = Alignment.Center) {
                androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Rounded.Edit, "Change colours", tint = readableOn(t.accent), modifier = Modifier.size(11.dp))
            }
        }
        Text(pack.name, style = HiveText.small, color = if (selected) c.text else c.textDim, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun ScrobbleRows(vm: MainViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val s by vm.scrobbler.settings.collectAsStateWithLifecycle()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var token by remember(s.listenBrainzToken) { mutableStateOf(s.listenBrainzToken) }
    var key by remember(s.lastFmKey) { mutableStateOf(s.lastFmKey) }
    var secret by remember(s.lastFmSecret) { mutableStateOf(s.lastFmSecret) }
    var error by remember { mutableStateOf<String?>(null) }

    SettingRow("ListenBrainz", if (s.listenBrainz && s.listenBrainzToken.isNotBlank()) "On" else "Paste your user token from listenbrainz.org/settings.") {
        HiveToggle(listOf("Off", "On"), if (s.listenBrainz) 1 else 0, { i -> vm.scrobbler.update { it.copy(listenBrainz = i == 1, listenBrainzToken = token.trim()) } })
    }
    Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        HiveField(token, { token = it.trim(); vm.scrobbler.update { st -> st.copy(listenBrainzToken = it.trim()) } }, "User token", type = KeyboardType.Password, modifier = Modifier.fillMaxWidth())
    }
    if (s.lastFmSession.isNotBlank()) {
        SettingRow("Last.fm", "Signed in as ${s.lastFmUser}") {
            HiveToggle(listOf("Off", "On"), if (s.lastFm) 1 else 0, { i -> vm.scrobbler.update { it.copy(lastFm = i == 1) } })
        }
        SettingRow("Sign out of Last.fm", "") { HiveButton("Sign out") { vm.scrobbler.update { it.copy(lastFm = false, lastFmSession = "", lastFmUser = "") } } }
    } else {
        SettingRow("Last.fm", "Your API key and shared secret from last.fm/api/account/create, then sign in.") {}
        Row(Modifier.padding(horizontal = 14.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HiveField(key, { key = it.trim() }, "API key", type = KeyboardType.Ascii, modifier = Modifier.weight(1f))
            HiveField(secret, { secret = it.trim() }, "Shared secret", type = KeyboardType.Password, modifier = Modifier.weight(1f))
        }
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HiveButton("Sign in", enabled = key.length >= 16 && secret.length >= 16, primary = s.lastFmPendingToken.isBlank()) {
                vm.scrobbler.update { it.copy(lastFmKey = key, lastFmSecret = secret) }
                scope.launch {
                    runCatching { vm.scrobbler.lastFmAuthUrl() }
                        .onSuccess { url -> error = null; runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, url)) } }
                        .onFailure { error = it.message }
                }
            }
            if (s.lastFmPendingToken.isNotBlank()) HiveButton("I've allowed Hive", primary = true) {
                scope.launch { runCatching { vm.scrobbler.finishLastFm() }.onSuccess { error = null }.onFailure { error = it.message } }
            }
        }
    }
    if (s.queued > 0) Text("${countOf(s.queued, "listen")} waiting to be sent", style = HiveText.small, color = Hive.colors.textDim, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
    (error ?: s.lastError)?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
}

/** The library in numbers: albums, artists, how long and how big, and its formats. */
@Composable
private fun LibraryInfoRows(vm: MainViewModel) {
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val info by vm.libraryInfo.collectAsStateWithLifecycle()
    val i = info ?: return
    if (i.songs == 0) return
    val hours = i.lengthMs / 3_600_000
    val length = if (hours >= 48) "${hours / 24} days ${hours % 24} hours" else "$hours hours ${(i.lengthMs / 60_000) % 60} minutes"
    Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf(
            "Albums" to "%,d".format(i.albums),
            "Artists" to "%,d".format(i.artists),
            "Playing time" to length,
            "Space used" to android.text.format.Formatter.formatShortFileSize(context, i.bytes),
            "Lossless" to "%,d of %,d songs".format(i.lossless, i.songs),
            "Formats" to i.formats.take(6).joinToString(", ") { (f, n) -> "$f %,d".format(n) },
        ).forEach { (label, value) ->
            Row {
                Text(label, style = HiveText.small, color = c.textDim, modifier = Modifier.width(120.dp))
                Text(value, style = HiveText.body, color = c.text, modifier = Modifier.weight(1f))
            }
        }
    }
}

/**
 * The Custom theme: a background and an accent of your own. Pick from the
 * swatches or fine-tune with hue, colour and brightness; the preview shows the
 * theme Hive makes of them (text, panels and glows follow), and the readout
 * says whether the accent stands out enough.
 */
@Composable
private fun CustomThemeDialog(vm: MainViewModel, onDismiss: () -> Unit) {
    val c = Hive.colors
    val start by vm.themes.custom.collectAsStateWithLifecycle()
    var bg by remember { mutableStateOf(start.first) }
    var accent by remember { mutableStateOf(start.second) }
    var editingAccent by remember { mutableStateOf(false) }
    val target = if (editingAccent) accent else bg
    fun set(color: Color) { if (editingAccent) accent = color else bg = color }
    val preview = remember(bg, accent) { com.local.hive.mobile.ui.theme.HiveColors.fromCss(com.local.hive.mobile.ui.theme.ThemeMaker.css(bg, accent, exact = true)) }

    HiveDialog(onDismiss, wide = true, spacing = 12.dp) {
        Text("Custom theme", style = HiveText.year, color = c.text)
        // The preview: the theme as Hive will draw it.
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(preview.bg).border(1.dp, preview.border, RoundedCornerShape(16.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(preview.panelStrong).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Song title", style = HiveText.rowStrong, color = preview.text)
                    Text("Artist · Album", style = HiveText.small, color = preview.textDim)
                }
                Box(Modifier.size(34.dp).clip(CircleShape).background(preview.accent), contentAlignment = Alignment.Center) {
                    androidx.compose.material3.Icon(androidx.compose.material.icons.Icons.Rounded.PlayArrow, null, tint = readableOn(preview.accent), modifier = Modifier.size(20.dp))
                }
            }
            Text("Now playing", style = HiveText.small, color = preview.accent)
        }
        var bgHsl by remember { mutableStateOf(com.local.hive.mobile.ui.theme.toHsl(bg)) }
        var accentHsl by remember { mutableStateOf(com.local.hive.mobile.ui.theme.toHsl(accent)) }
        HiveToggle(listOf("Background", "Accent"), if (editingAccent) 1 else 0, { editingAccent = it == 1 })
        // Swatches: bright, soft and deep colours for either.
        val swatches = remember {
            listOf(0xFFFFF3A3, 0xFFFFD23F, 0xFFFF9F45, 0xFFFF8A7A, 0xFFFF5D73, 0xFFFFC4E1, 0xFFD9D2FF, 0xFFCDEBFF, 0xFF8FCBE6, 0xFFB8F0D4,
                0xFF7BD389, 0xFF2EC4B6, 0xFF3A86FF, 0xFF5A3FD1, 0xFF8338EC, 0xFFC2185B, 0xFF8C1C32, 0xFF0E4F6E, 0xFF1F2A9C, 0xFF0F5A43,
                0xFF4B1F6F, 0xFF121317, 0xFFF6F7FB, 0xFF6B4F3A).map { Color(it) }
        }
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            swatches.forEach { sw ->
                Box(Modifier.size(34.dp).clip(CircleShape).background(sw).border(if (sw == target) 3.dp else 1.dp, if (sw == target) c.accent else c.border, CircleShape).clickable {
                    set(sw); if (editingAccent) accentHsl = com.local.hive.mobile.ui.theme.toHsl(sw) else bgHsl = com.local.hive.mobile.ui.theme.toHsl(sw)
                })
            }
        }
        // Fine-tuning, as hue, colour (saturation) and brightness (lightness), anywhere on each. The
        // sliders keep their own places: black, white and greys don't hold a hue to read back.
        val (h, sat, light) = if (editingAccent) accentHsl else bgHsl
        fun tune(next: Triple<Float, Float, Float>) {
            if (editingAccent) accentHsl = next else bgHsl = next
            set(com.local.hive.mobile.ui.theme.hsl(next.first, next.second, next.third, 1f))
        }
        HslSlider("Hue", h / 360f) { tune(Triple(it * 360f, sat, light)) }
        HslSlider("Colour", sat) { tune(Triple(h, it, light)) }
        HslSlider("Brightness", light) { tune(Triple(h, sat, it)) }
        val stands = com.local.hive.mobile.ui.theme.HiveColors.contrast(accent, bg)
        // Any colours are allowed; a pair that's hard to read is only pointed out.
        if (stands < 3f) Text("Heads up: the accent is close to the background, so buttons and accent-coloured text might be hard to see.", style = HiveText.small, color = Color(0xFFFF8A8A))
        else Text("The accent stands out well on this background.", style = HiveText.small, color = c.textDim)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            HiveButton("Cancel") { onDismiss() }
            HiveButton("Use these colours", primary = true) { vm.themes.setCustom(bg, accent); onDismiss() }
        }
    }
}

@Composable
private fun HslSlider(label: String, value: Float, onChange: (Float) -> Unit) {
    val c = Hive.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = HiveText.small, color = c.textDim, modifier = Modifier.width(84.dp))
        androidx.compose.material3.Slider(
            value, onChange, Modifier.weight(1f),
            colors = androidx.compose.material3.SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent, inactiveTrackColor = c.border),
        )
    }
}
