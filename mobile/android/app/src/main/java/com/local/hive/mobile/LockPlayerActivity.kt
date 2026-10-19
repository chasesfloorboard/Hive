package com.local.hive.mobile

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import com.local.hive.mobile.ui.HiveThemed
import com.local.hive.mobile.ui.LockPlayer
import com.local.hive.mobile.ui.MainViewModel

/**
 * Hive's player shown over the lock screen, the way Samsung Music's lock
 * player is: a screen allowed to show while the phone is locked, in its own
 * task away from Recents, gone as soon as the phone is unlocked.
 */
class LockPlayerActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    private val unlocked = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setShowWhenLocked(true)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        window.attributes.layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        (application as HiveApp).player.connect()
        ContextCompat.registerReceiver(this, unlocked, IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED)
        // Back on a locked phone stays here; the phone's own unlock is the way out.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() = unlock() })
        setContent { HiveThemed(vm) { LockPlayer(vm, onUnlock = ::unlock) } }
    }

    override fun onResume() {
        super.onResume()
        // Opened with the phone already unlocked (or the lock turned off): nothing to cover.
        if (!(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) finish()
    }

    private fun unlock() {
        (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = finish()
        })
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(unlocked) }
        super.onDestroy()
    }

    companion object {
        private const val PREF = "lock-player"

        /** Whether Hive shows itself over the lock screen while music plays. */
        fun enabled(context: Context) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean(PREF, false)
        fun setEnabled(context: Context, on: Boolean) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean(PREF, on).apply()

        /** Android lets an app open a screen from the background only with "Display over other apps". */
        fun permitted(context: Context) = Settings.canDrawOverlays(context)

        /** Called as the screen goes off with music playing, so the player is there when it comes back on. */
        fun showIfWanted(context: Context) {
            if (!enabled(context) || !permitted(context)) return
            val open = Intent(context, LockPlayerActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            runCatching { context.startActivity(open) }
        }
    }
}
