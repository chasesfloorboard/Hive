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
    /** When the player was last touched (or came up): left alone, the screen should go off. */
    private var touchedAt = 0L
    private val idleWatch = object : Runnable {
        override fun run() {
            val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
            val locked = (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
            // Still on well past the lock screen's timeout: the phone didn't take the player's (Samsung's
            // may not). The phone's own lock screen takes over and goes off by itself; the player is
            // back when the phone next wakes.
            // In the car the phone stays on while it charges: the player stays up for the drive, as the
            // lock screen's small media pill is too small to use while driving.
            if (awake && locked && !leaving && !CarLog.inCar(this@LockPlayerActivity) && System.currentTimeMillis() - touchedAt > SLEEP_AFTER_MS + IDLE_GRACE_MS) {
                CarLog.lockPlayer(this@LockPlayerActivity, "left idle, the lock screen takes over so the screen can go off")
                wentHome = true
                moveTaskToBack(true)
                return
            }
            window.decorView.postDelayed(this, 1_000)
        }
    }

    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        touchedAt = System.currentTimeMillis()
        return super.dispatchTouchEvent(ev)
    }

    /** A call rings or is on: the player steps aside for the phone's call screen and comes back after. */
    private var steppedAside = false
    private val callWatch: Any? = if (android.os.Build.VERSION.SDK_INT >= 31) android.media.AudioManager.OnModeChangedListener { callChanged() } else null

    private fun callChanged() {
        if (inCall(this)) {
            if (!steppedAside) { steppedAside = true; CarLog.lockPlayer(this, "steps aside for a call"); moveTaskToBack(true) }
        } else if (steppedAside) {
            steppedAside = false
            val locked = (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
            if (locked && !leaving && !isFinishing) { CarLog.lockPlayer(this, "call over, comes back"); showIfWanted(this) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setShowWhenLocked(true)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = androidx.activity.SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        window.attributes.layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        // The screen goes off as soon as it would on the lock screen itself, not after the phone's
        // longer screen timeout. (The window field the lock screen uses for this isn't in the SDK.)
        runCatching {
            val attrs = window.attributes
            android.view.WindowManager.LayoutParams::class.java.getField("userActivityTimeout").setLong(attrs, SLEEP_AFTER_MS)
            window.attributes = attrs
        }.onFailure { CarLog.lockPlayer(this, "screen timeout not set: $it") }
        (application as HiveApp).player.connect()
        ContextCompat.registerReceiver(this, unlocked, IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED)
        // Back on a locked phone stays here; the phone's own unlock is the way out.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() = unlock() })
        setContent { HiveThemed(vm) { LockPlayer(vm, onUnlock = ::unlock) } }
        if (android.os.Build.VERSION.SDK_INT >= 31) getSystemService(android.media.AudioManager::class.java)
            .addOnModeChangedListener(ContextCompat.getMainExecutor(this), callWatch as android.media.AudioManager.OnModeChangedListener)
        CarLog.lockPlayer(this, "opens")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        leaving = false
        wentHome = false
    }

    /**
     * Home on the locked phone: the lock screen and its notifications show, and
     * the player waits behind them until the phone next locks or wakes: music
     * starting again (a new song, a crossfade) doesn't bring it back. In the
     * car, Android Auto taking over as the phone wakes looks the same to Hive,
     * so there only a Home pressed once the player has been up a moment counts.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!CarLog.inCar(this) || System.currentTimeMillis() - resumedAt > HOME_AFTER_MS) {
            wentHome = true; sentAway = true; CarLog.lockPlayer(this, "home pressed")
        }
    }

    override fun onResume() {
        super.onResume()
        resumedAt = System.currentTimeMillis()
        touchedAt = resumedAt
        wentHome = false
        sentAway = false
        window.decorView.removeCallbacks(idleWatch)
        window.decorView.postDelayed(idleWatch, 1_000)
        // Never over a call: the phone's call screen comes first.
        if (inCall(this)) { steppedAside = true; moveTaskToBack(true); return }
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
        window.decorView.removeCallbacks(idleWatch)
        if (leaving || wentHome || isFinishing || isChangingConfigurations) return
        val locked = (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
        val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
        CarLog.lockPlayer(this, "pushed away")
        if (!locked || !awake || !CarLog.inCar(this)) return
        // Only Android Auto's takeover as the phone wakes is undone. Anything later (Home, whether or
        // not Android reported it as Home, or an app the user opened) is the user's choice and stands.
        if (System.currentTimeMillis() - screenChangedAt > CAR_TAKEOVER_MS) return
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
        if (android.os.Build.VERSION.SDK_INT >= 31) runCatching {
            getSystemService(android.media.AudioManager::class.java).removeOnModeChangedListener(callWatch as android.media.AudioManager.OnModeChangedListener)
        }
        super.onDestroy()
    }

    companion object {
        /** When the player was last brought back after being pushed away (see onStop). */
        private val broughtBack = mutableListOf<Long>()
        /** Home pressed on the player: it stays away until the phone next goes to sleep or wakes (see [screenChanged]). */
        @Volatile private var sentAway = false

        /** The screen went off or came on: a player sent away with Home may show again. */
        fun screenChanged() { sentAway = false; screenChangedAt = System.currentTimeMillis() }
        /** When the screen last went off or came on. */
        @Volatile private var screenChangedAt = 0L
        /** Android Auto takes the screen over as the phone wakes; later than this, what pushed the player away was the user. */
        private const val CAR_TAKEOVER_MS = 5_000L
        private const val PREF = "lock-player"
        private const val HOME_AFTER_MS = 2_000L
        /** The lock screen's own screen timeout. */
        private const val SLEEP_AFTER_MS = 10_000L
        /** How long past [SLEEP_AFTER_MS] the screen may stay on before the player steps aside for the lock screen. */
        private const val IDLE_GRACE_MS = 5_000L

        /** Whether Hive shows itself over the lock screen while music plays. */
        fun enabled(context: Context) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean(PREF, false)
        fun setEnabled(context: Context, on: Boolean) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean(PREF, on).apply()

        /** Android lets an app open a screen from the background only with "Display over other apps". */
        fun permitted(context: Context) = Settings.canDrawOverlays(context)

        /** A call ringing or on (phone, or a call app like WhatsApp): the phone's sound is set for calls then. */
        fun inCall(context: Context) = (context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager).mode != android.media.AudioManager.MODE_NORMAL

        /** Called while Hive is in use as the screen goes off or comes on locked, or as music starts on a locked phone. */
        fun showIfWanted(context: Context) {
            if (!enabled(context) || !permitted(context) || inCall(context) || sentAway) return
            val open = Intent(context, LockPlayerActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
            runCatching { context.startActivity(open) }
        }
    }
}
