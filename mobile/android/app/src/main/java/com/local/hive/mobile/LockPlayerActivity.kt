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
import com.local.hive.mobile.playback.CarLog
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
        override fun onReceive(context: Context, intent: Intent) { leaving("unlocked"); finish() }
    }
    /** Set when the player goes because it should (unlocked, swiped up): nothing brings it back then. */
    private var leaving = false
    private fun leaving(why: String) { leaving = true; CarLog.lockPlayer(this, "closes: $why") }
    /** When the player last came to the front, and whether the user then sent it away with Home. */
    private var resumedAt = 0L
    private var wentHome = false

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
        CarLog.lockPlayer(this, "opens")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        leaving = false
        wentHome = false
    }

    /**
     * Home on the locked phone: the lock screen and its notifications show, and
     * the player waits behind them until the phone next locks or wakes. Android
     * Auto taking over as the phone wakes looks the same to Hive, so only a
     * Home pressed once the player has been up a moment counts.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (System.currentTimeMillis() - resumedAt > HOME_AFTER_MS) { wentHome = true; CarLog.lockPlayer(this, "home pressed") }
    }

    override fun onResume() {
        super.onResume()
        resumedAt = System.currentTimeMillis()
        wentHome = false
        // Opened with the phone already unlocked (or the lock turned off): nothing to cover.
        if (!(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) { leaving("phone not locked"); finish() }
    }

    /**
     * Pushed off the lock screen while the phone is still locked and on: in the
     * car, Android Auto (or the phone's car mode) brings its own screen up as the
     * phone wakes, and Samsung's lock screen falls back to its Now Bar. Hive's
     * player comes straight back, a few times a minute at most so it never
     * fights a screen the user opened (the camera, an alarm).
     */
    override fun onStop() {
        super.onStop()
        if (leaving || wentHome || isFinishing || isChangingConfigurations) return
        val locked = (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
        val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
        CarLog.lockPlayer(this, "pushed away")
        if (!locked || !awake || !CarLog.inCar(this)) return
        val now = System.currentTimeMillis()
        broughtBack.removeAll { now - it > 60_000 }
        if (broughtBack.size >= 3) return
        broughtBack += now
        window.decorView.postDelayed({ CarLog.lockPlayer(this, "comes back"); showIfWanted(this) }, 400)
    }

    private fun unlock() {
        (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { leaving("swiped up"); finish() }
        })
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(unlocked) }
        super.onDestroy()
    }

    companion object {
        /** When the player was last brought back after being pushed away (see onStop). */
        private val broughtBack = mutableListOf<Long>()
        private const val PREF = "lock-player"
        private const val HOME_AFTER_MS = 2_000L

        /** Whether Hive shows itself over the lock screen while music plays. */
        fun enabled(context: Context) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean(PREF, false)
        fun setEnabled(context: Context, on: Boolean) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean(PREF, on).apply()

        /** Android lets an app open a screen from the background only with "Display over other apps". */
        fun permitted(context: Context) = Settings.canDrawOverlays(context)

        /** Called while Hive is in use as the screen goes off or comes on locked, or as music starts on a locked phone. */
        fun showIfWanted(context: Context) {
            if (!enabled(context) || !permitted(context)) return
            val open = Intent(context, LockPlayerActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            runCatching { context.startActivity(open) }
        }
    }
}
