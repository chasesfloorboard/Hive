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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_DELETIONS, false)) vm.openDeletions.value = true
        if (intent.getBooleanExtra(EXTRA_GO_HOME, false)) vm.goHome()
        if (intent.getBooleanExtra(EXTRA_INSTALL_UPDATE, false)) (application as HiveApp).appUpdater.install(this)
        handleSpotifyReturn(intent)
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
            val app = application as HiveApp
            app.scope.launch { app.spotifyAccount.complete(data) }
        }
    }

    companion object {
        const val EXTRA_GO_HOME = "go_home"
        const val EXTRA_OPEN_PLAYER = "open_player"
        /** Opens the deleted-songs choice (from its notification). */
        const val EXTRA_OPEN_DELETIONS = "open_deletions"
        /** "Connect automatically" off from the start (the end-to-end test). */
        const val EXTRA_NO_AUTO_CONNECT = "no_auto_connect"
        const val EXTRA_INSTALL_UPDATE = "install_update"
    }
}
