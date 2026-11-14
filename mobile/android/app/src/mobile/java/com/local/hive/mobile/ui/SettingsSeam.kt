package com.local.hive.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import kotlinx.coroutines.launch

/**
 * Hive Mobile's Settings → Accounts page: Apple Music, Spotify, Scrobbling and Soulseek. All of it is
 * absent from Hive Clean (see the Clean no-op of [accountsSettings] / [streamingAccountsAvailable]).
 */

/** Whether the Accounts settings page has anything to show (false in Hive Clean, which hides the entry). */
fun streamingAccountsAvailable(): Boolean = true

/** The Settings → Accounts sections. Empty in Hive Clean. */
fun LazyListScope.accountsSettings(vm: MainViewModel) {
    item { Section("Apple Music", "Your playlists and songs, through Apple's web player sign-in. Unofficial: Apple may stop it working at any time.") { AppleRows(vm) } }
    item { Section("Spotify", "Your playlists and Liked Songs, and Spotify search.") { SpotifyRows(vm) } }
    item { Section("Scrobbling", "Send what you play to ListenBrainz or Last.fm.") { ScrobbleRows(vm) } }
    item { Section("Soulseek", "Download albums from Apple Music and Spotify pages. Hive shares nothing.") { SoulseekRows() } }
}

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
private fun AppleRows(vm: MainViewModel) {
    val svm = rememberStreamingVm()
    val context = androidx.compose.ui.platform.LocalContext.current
    val user by svm.appleUser.collectAsStateWithLifecycle()
    if (user.signedIn) {
        SettingRow("Signed in", "Your playlists and songs appear on the Apple Music page.") { HiveButton("Sign out") { svm.appleAccount.signOut() } }
    } else {
        SettingRow("Your Apple Music library", "Sign in on Apple's own page. Hive never sees your password.") {
            HiveButton("Sign in", primary = true) { context.startActivity(android.content.Intent(context, com.local.hive.mobile.AppleSignInActivity::class.java)) }
        }
    }
    user.error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
}

@Composable
private fun SpotifyRows(vm: MainViewModel) {
    val svm = rememberStreamingVm()
    val c = Hive.colors
    val context = androidx.compose.ui.platform.LocalContext.current
    val user by svm.spotifyUser.collectAsStateWithLifecycle()
    var clientId by remember(user.clientId) { mutableStateOf(user.clientId) }
    if (user.signedIn) {
        SettingRow("Signed in as ${user.name.ifBlank { "you" }}", "Your playlists and Liked Songs appear on the Spotify page.") { HiveButton("Sign out") { svm.spotifyAccount.signOut() } }
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
                svm.spotifyAccount.setClientId(clientId)
                runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, svm.spotifyAccount.authorizeUrl())) }
            }
        }
    }
    user.error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
}

@Composable
private fun ScrobbleRows(vm: MainViewModel) {
    val svm = rememberStreamingVm()
    val context = androidx.compose.ui.platform.LocalContext.current
    val s by svm.scrobbler.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var token by remember(s.listenBrainzToken) { mutableStateOf(s.listenBrainzToken) }
    var key by remember(s.lastFmKey) { mutableStateOf(s.lastFmKey) }
    var secret by remember(s.lastFmSecret) { mutableStateOf(s.lastFmSecret) }
    var error by remember { mutableStateOf<String?>(null) }

    SettingRow("ListenBrainz", if (s.listenBrainz && s.listenBrainzToken.isNotBlank()) "On" else "Paste your user token from listenbrainz.org/settings.") {
        HiveToggle(listOf("Off", "On"), if (s.listenBrainz) 1 else 0, { i -> svm.scrobbler.update { it.copy(listenBrainz = i == 1, listenBrainzToken = token.trim()) } })
    }
    Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        HiveField(token, { token = it.trim(); svm.scrobbler.update { st -> st.copy(listenBrainzToken = it.trim()) } }, "User token", type = KeyboardType.Password, modifier = Modifier.fillMaxWidth())
    }
    if (s.lastFmSession.isNotBlank()) {
        SettingRow("Last.fm", "Signed in as ${s.lastFmUser}") {
            HiveToggle(listOf("Off", "On"), if (s.lastFm) 1 else 0, { i -> svm.scrobbler.update { it.copy(lastFm = i == 1) } })
        }
        SettingRow("Sign out of Last.fm", "") { HiveButton("Sign out") { svm.scrobbler.update { it.copy(lastFm = false, lastFmSession = "", lastFmUser = "") } } }
    } else {
        SettingRow("Last.fm", "Your API key and shared secret from last.fm/api/account/create, then sign in.") {}
        Row(Modifier.padding(horizontal = 14.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HiveField(key, { key = it.trim() }, "API key", type = KeyboardType.Ascii, modifier = Modifier.weight(1f))
            HiveField(secret, { secret = it.trim() }, "Shared secret", type = KeyboardType.Password, modifier = Modifier.weight(1f))
        }
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HiveButton("Sign in", enabled = key.length >= 16 && secret.length >= 16, primary = s.lastFmPendingToken.isBlank()) {
                svm.scrobbler.update { it.copy(lastFmKey = key, lastFmSecret = secret) }
                scope.launch {
                    runCatching { svm.scrobbler.lastFmAuthUrl() }
                        .onSuccess { url -> error = null; runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, url)) } }
                        .onFailure { error = it.message }
                }
            }
            if (s.lastFmPendingToken.isNotBlank()) HiveButton("I've allowed Hive", primary = true) {
                scope.launch { runCatching { svm.scrobbler.finishLastFm() }.onSuccess { error = null }.onFailure { error = it.message } }
            }
        }
    }
    if (s.queued > 0) Text("${countOf(s.queued, "listen")} waiting to be sent", style = HiveText.small, color = Hive.colors.textDim, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
    (error ?: s.lastError)?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
}
