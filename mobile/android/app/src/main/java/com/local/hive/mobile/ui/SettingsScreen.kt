package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.mix
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
                Section("Streaming", "Apple Music and Spotify songs that aren't on this phone.") {
                    val yt by vm.youTubeMusic.enabled.collectAsStateWithLifecycle()
                    SettingRow("Full songs from YouTube Music", if (yt) "Found on YouTube Music, as Hive on your PC does. Through your PC when it's on." else "Off: they play as 30-second previews.") {
                        HiveToggle(listOf("Off", "On"), if (yt) 1 else 0, { i -> vm.youTubeMusic.setEnabled(i == 1) })
                    }
                }
            }
            item {
                Section("Spotify", "Sign in to see your playlists and Liked Songs, and to search Spotify. Shared links work without signing in.") { SpotifyRows(vm) }
            }
            item {
                Section("Sound", "Hive's equaliser runs inside the player, so it works on speakers, headphones and Bluetooth alike.") {
                    val eq by vm.equaliser.state.collectAsStateWithLifecycle()
                    SettingRow("Equaliser", if (eq.enabled) eq.preset else "Off") { SmallButton("Open") { onOpenEqualiser() } }
                    val modes = listOf("off", "track", "album", "smart")
                    SettingRow("ReplayGain", "Evens out loudness from the songs' ReplayGain tags. Smart uses album gain while an album plays in order.") {}
                    HiveToggle(listOf("Off", "Track", "Album", "Smart"), modes.indexOf(eq.replayGain).coerceAtLeast(0), { i -> vm.equaliser.update { it.copy(replayGain = modes[i]) } }, Modifier.padding(horizontal = 16.dp))
                    SettingRow("Prevent clipping", "Never raise a song past its own peak.") {
                        HiveToggle(listOf("Off", "On"), if (eq.clippingGuard) 1 else 0, { i -> vm.equaliser.update { it.copy(clippingGuard = i == 1) } })
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
                        SmallButton(if (scanning) "Scanning…" else "Rescan", enabled = !scanning) { vm.rescan() }
                    }
                }
            }
            item {
                Section("Appearance", "Hive's themes, or your own .hive-theme. While a song plays, the accent and backdrop follow its cover.") { ThemeRows(vm) }
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

/** Hive's small control button (`.sidebar-add`). */
@Composable
private fun SmallButton(label: String, enabled: Boolean = true, primary: Boolean = false, onClick: () -> Unit) {
    val c = Hive.colors
    Box(
        Modifier.height(36.dp).clip(RoundedCornerShape(10.dp))
            .alpha(if (enabled) 1f else 0.45f)
            .background(if (primary) c.accent else mix(c.accent, c.panelStrong, 0.05f))
            .border(1.dp, mix(c.accent, c.border, 0.14f), RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveText.pill, color = if (primary) readableOn(c.accent) else c.text) }
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
    SettingRow("Favorites sync", detail) { SmallButton(if (link.syncing) "Syncing…" else "Sync now", enabled = !link.syncing, primary = true) { vm.syncNow() } }
    link.error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    SongSyncRows(vm)
    AutoConnectRow(vm)
    SettingRow("Unpair this phone", "Stops syncing. Favorites already here stay.") { SmallButton("Unpair") { vm.unpair() } }
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
    fun songs(n: Int) = if (n == 1) "1 song" else "%,d songs".format(n)
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
            if (s.checking || plan == null) SmallButton(if (s.checking) "Checking…" else "Check", enabled = !s.checking) { vm.checkSongs() }
            else if (plan.toPhone > 0 || plan.toPc > 0) SmallButton("Start song sync", primary = true) { vm.setSongSync(true) }
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
        SettingRow("Song sync", status) { SmallButton("Turn off") { vm.setSongSync(false) } }
    }
    s.message?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    // Songs deleted on one side since they were on both: the user decides what happens on the other.
    val gone by vm.deletions.collectAsStateWithLifecycle()
    if (gone.count > 0) SettingRow("Deleted songs", listOfNotNull(
        gone.fromPc.size.takeIf { it > 0 }?.let { "${songs(it)} deleted on your PC" },
        gone.fromPhone.size.takeIf { it > 0 }?.let { "${songs(it)} deleted on this phone" },
    ).joinToString(" · ")) { SmallButton("Review", primary = true) { vm.openDeletions.value = true } }
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
        else SmallButton("Search") { vm.discover() }
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
        Field(host, { host = it }, "PC address", KeyboardType.Uri, Modifier.weight(1f))
        Field(port, { port = it.filter(Char::isDigit) }, "Port", KeyboardType.Number, Modifier.width(96.dp))
    }
    Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        Field(code, { code = it.filter(Char::isDigit).take(6) }, "Pairing code", KeyboardType.NumberPassword, Modifier.fillMaxWidth())
    }
    (error ?: linkError.error)?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
        SmallButton(if (busy) "Pairing…" else "Pair", enabled = !busy && host.isNotBlank() && code.length == 6, primary = true) {
            vm.pair(host, port.toIntOrNull() ?: HiveLinkClient.DEFAULT_PORT, code)
        }
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, type: KeyboardType, modifier: Modifier) {
    val c = Hive.colors
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(mix(c.accent, c.panelStrong, 0.05f)).border(1.dp, c.border, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 9.dp)) {
        HiveLabel(label)
        BasicTextField(value, onChange, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = SolidColor(c.accent), keyboardOptions = KeyboardOptions(keyboardType = type), modifier = Modifier.fillMaxWidth().padding(top = 2.dp))
    }
}

@Composable
private fun SpotifyRows(vm: MainViewModel) {
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val user by vm.spotifyUser.collectAsStateWithLifecycle()
    var clientId by remember(user.clientId) { mutableStateOf(user.clientId) }
    if (user.signedIn) {
        SettingRow("Signed in as ${user.name.ifBlank { "you" }}", "Your playlists and Liked Songs appear on the Spotify page.") { SmallButton("Sign out") { vm.spotifyAccount.signOut() } }
    } else {
        Text(
            "Once: create an app at developer.spotify.com/dashboard, add the redirect URI ${com.local.hive.mobile.stream.SpotifyAccount.REDIRECT}, add your Spotify account under User Management, then paste the app's Client ID here.",
            style = HiveText.small, color = c.textDim, modifier = Modifier.padding(horizontal = 18.dp, vertical = 6.dp),
        )
        Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
            Field(clientId, { clientId = it.trim() }, "Client ID", KeyboardType.Ascii, Modifier.fillMaxWidth())
        }
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
            SmallButton("Sign in with Spotify", enabled = clientId.length >= 16, primary = true) {
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
    androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(packs) { pack -> ThemeSwatch(pack, pack.name == current) { vm.applyTheme(pack) } }
    }
    SettingRow("Import a theme", "A .hive-theme from Hive on your PC, or a CSS file of Hive's variables.") {
        SmallButton("Import") { importer.launch(arrayOf("*/*")) }
    }
    note?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp)) }
}

/** A theme as a little window: its background, a panel and its accent. */
@Composable
private fun ThemeSwatch(pack: com.local.hive.mobile.ui.theme.ThemePack, selected: Boolean, onClick: () -> Unit) {
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
        Field(token, { token = it.trim(); vm.scrobbler.update { st -> st.copy(listenBrainzToken = it.trim()) } }, "User token", KeyboardType.Password, Modifier.fillMaxWidth())
    }
    if (s.lastFmSession.isNotBlank()) {
        SettingRow("Last.fm", "Signed in as ${s.lastFmUser}") {
            HiveToggle(listOf("Off", "On"), if (s.lastFm) 1 else 0, { i -> vm.scrobbler.update { it.copy(lastFm = i == 1) } })
        }
        SettingRow("Sign out of Last.fm", "") { SmallButton("Sign out") { vm.scrobbler.update { it.copy(lastFm = false, lastFmSession = "", lastFmUser = "") } } }
    } else {
        SettingRow("Last.fm", "Your API key and shared secret from last.fm/api/account/create, then sign in.") {}
        Row(Modifier.padding(horizontal = 14.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(key, { key = it.trim() }, "API key", KeyboardType.Ascii, Modifier.weight(1f))
            Field(secret, { secret = it.trim() }, "Shared secret", KeyboardType.Password, Modifier.weight(1f))
        }
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallButton("Sign in", enabled = key.length >= 16 && secret.length >= 16, primary = s.lastFmPendingToken.isBlank()) {
                vm.scrobbler.update { it.copy(lastFmKey = key, lastFmSecret = secret) }
                scope.launch {
                    runCatching { vm.scrobbler.lastFmAuthUrl() }
                        .onSuccess { url -> error = null; runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, url)) } }
                        .onFailure { error = it.message }
                }
            }
            if (s.lastFmPendingToken.isNotBlank()) SmallButton("I've allowed Hive", primary = true) {
                scope.launch { runCatching { vm.scrobbler.finishLastFm() }.onSuccess { error = null }.onFailure { error = it.message } }
            }
        }
    }
    if (s.queued > 0) Text("${countOf(s.queued, "listen")} waiting to be sent", style = HiveText.small, color = Hive.colors.textDim, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
    (error ?: s.lastError)?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
}
