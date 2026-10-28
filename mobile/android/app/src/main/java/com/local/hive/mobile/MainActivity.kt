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
        if (granted[audioPermission] == true) vm.rescan()
    }

    private val audioPermission =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Black status and navigation bars, as in Samsung Music's dark mode.
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.BLACK),
        )
        (application as HiveApp).player.connect()
        val openPlayer = intent?.getBooleanExtra(EXTRA_OPEN_PLAYER, false) == true
        if (intent?.getBooleanExtra(EXTRA_OPEN_DELETIONS, false) == true) vm.openDeletions.value = true
        setContent { HiveRoot(vm, openPlayer) }

        val wanted = buildList {
            add(audioPermission)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = wanted.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permissions.launch(missing.toTypedArray())
        handleSpotifyReturn(intent)
        if (savedInstanceState == null) handleVoice(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_DELETIONS, false)) vm.openDeletions.value = true
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
        const val EXTRA_OPEN_PLAYER = "open_player"
        /** Opens the deleted-songs choice (from its notification). */
        const val EXTRA_OPEN_DELETIONS = "open_deletions"
    }
}
