package com.local.hive.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import com.local.hive.mobile.ui.HiveRoot
import com.local.hive.mobile.ui.MainViewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        vm.refreshAudioPermission()
        if (granted[audioPermission] == true) vm.rescan()
    }

    private val audioPermission =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

    override fun onCreate(savedInstanceState: Bundle?) {
        // Opened by a test (scripts/e2e) with "Connect automatically" off, so it only ever pairs
        // with the test's own Hive, never with a Hive it finds on the network.
        if (intent?.getBooleanExtra(EXTRA_NO_AUTO_CONNECT, false) == true) (application as HiveApp).linkStore.autoConnect = false
        super.onCreate(savedInstanceState)
        // Black status and navigation bars, as in Samsung Music's dark mode.
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.BLACK),
        )
        (application as HiveApp).player.connect()
        val openPlayer = intent?.getBooleanExtra(EXTRA_OPEN_PLAYER, false) == true
        if (intent?.getBooleanExtra(EXTRA_OPEN_DELETIONS, false) == true) vm.openDeletions.value = true
        if (intent?.getBooleanExtra(EXTRA_GO_HOME, false) == true) vm.goHome()
        // The empty states' "Allow music access" button routes here: re-ask if we still can, otherwise
        // (permanently denied) send the user to this app's settings page to flip it on by hand.
        vm.requestAudioPermission = {
            if (androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(this, audioPermission)) permissions.launch(arrayOf(audioPermission))
            else runCatching { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))) }
        }
        setContent { HiveRoot(vm, openPlayer) }

        val wanted = buildList {
            add(audioPermission)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = wanted.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permissions.launch(missing.toTypedArray())
        handleSpotifyReturn(intent)
        handleMusicLink(intent)
        if (savedInstanceState == null) handleVoice(intent)
        // "Hive Mobile x is ready": tapping the notification installs it.
        if (intent?.getBooleanExtra(EXTRA_INSTALL_UPDATE, false) == true) (application as HiveApp).appUpdater.install(this)
    }

    // Opening Hive looks for an update: from the PC when it's reachable, else GitHub (every 10 minutes at most).
    override fun onResume() {
        super.onResume()
        vm.refreshAudioPermission()   // self-correct the empty state after a trip to system settings
        (application as HiveApp).appUpdater.checkAnywhere()
    }

    // Whether Hive's own UI was the app in use — so the lock-screen player knows whether unlocking
    // should return to Hive (it was) or to whatever app the user was really in (it wasn't).
    override fun onStart() { super.onStart(); isForeground = true }
    override fun onStop() { super.onStop(); isForeground = false; lastForegroundAt = System.currentTimeMillis() }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_DELETIONS, false)) vm.openDeletions.value = true
        if (intent.getBooleanExtra(EXTRA_GO_HOME, false)) vm.goHome()
        if (intent.getBooleanExtra(EXTRA_INSTALL_UPDATE, false)) (application as HiveApp).appUpdater.install(this)
        handleSpotifyReturn(intent)
        handleMusicLink(intent)
        handleVoice(intent)
    }

    /** "Hey Google, play Outkast": the assistant opens Hive with the words; play what they name. */
    private fun handleVoice(intent: Intent?) {
        if (intent?.action != android.provider.MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH) return
        val app = application as HiveApp
        val query = intent.getStringExtra(android.app.SearchManager.QUERY).orEmpty()
        app.scope.launch {
            val tracks = com.local.hive.mobile.playback.LibraryBrowser(app, app.database.dao()).voice(query, intent.extras)
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                if (tracks.isNotEmpty()) app.player.play(tracks)
                else android.widget.Toast.makeText(app, "Nothing on this phone matches “$query”", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun handleSpotifyReturn(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "hive-mobile" && data.host == "spotify-auth") {
            // Spotify OAuth completion lives in the Mobile edition only (see the completeSpotifyReturn seam).
            com.local.hive.mobile.ui.completeSpotifyReturn(application, data)
        }
    }

    /** A tapped Spotify/Apple Music album link (ACTION_VIEW), or one shared to Hive (ACTION_SEND): open it. */
    private fun handleMusicLink(intent: Intent?) {
        musicUrlFrom(intent)?.let { vm.openLink.value = it }
    }

    private fun musicUrlFrom(intent: Intent?): String? {
        intent ?: return null
        val text = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.toString()
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            else -> null
        } ?: return null
        // A shared string may read "Artist — Album https://open.spotify.com/album/…": pull the link out.
        val url = Regex("""https?://(open\.spotify\.com|music\.apple\.com)/\S+""").find(text)?.value
            ?.trimEnd('.', ',', ')', '"', '\'') ?: return null
        val supported = ("open.spotify.com" in url && Regex("""/(album|playlist)/""").containsMatchIn(url)) ||
            ("music.apple.com" in url && Regex("""/(album|playlist|artist)/""").containsMatchIn(url))
        return if (supported) url else null
    }

    companion object {
        /** Whether Hive's main UI is on screen right now. */
        @Volatile var isForeground = false; private set
        /** When Hive's main UI last left the screen. */
        @Volatile private var lastForegroundAt = 0L
        /**
         * Was Hive's own UI the app in use just before the screen locked? True while it's showing, and for
         * a moment after — the screen-off broadcast and this activity's onStop race, so a phone locked
         * straight from Hive mustn't read as "wasn't in Hive". A second spent in another app is longer than
         * that moment, so switching away before locking correctly reads as false.
         */
        fun wasRecentlyForeground() = isForeground || System.currentTimeMillis() - lastForegroundAt < 1_500L

        const val EXTRA_GO_HOME = "go_home"
        const val EXTRA_OPEN_PLAYER = "open_player"
        /** Opens the deleted-songs choice (from its notification). */
        const val EXTRA_OPEN_DELETIONS = "open_deletions"
        /** "Connect automatically" off from the start (the end-to-end test). */
        const val EXTRA_NO_AUTO_CONNECT = "no_auto_connect"
        const val EXTRA_INSTALL_UPDATE = "install_update"
    }
}
