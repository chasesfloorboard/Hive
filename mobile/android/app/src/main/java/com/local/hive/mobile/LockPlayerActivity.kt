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
 * Hive's player shown over the lock screen: a screen allowed to show while the phone is locked, in its
 * own task away from Recents. It comes up when the phone wakes on a locked screen and STAYS after a
 * face/fingerprint unlock, so you can see and use it. Only Back or Home dismisses it -- returning to
 * whatever was open before the player (the previous app, or the home screen), never forcing Hive
 * forward. Left untouched, it steps aside after a while so the screen can sleep.
 */
class LockPlayerActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    private val unlocked = object : BroadcastReceiver() {
        // A face/fingerprint/PIN unlock no longer dismisses the player: it stays up so you can see and use
        // it, and only Back or Home sends it away.
        override fun onReceive(context: Context, intent: Intent) {
            lastUnlockedAt = System.currentTimeMillis()
        }
    }
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var unlockReShowRunnable: Runnable? = null
    // Keep the player up across a face/fingerprint unlock. The keyguard dismiss reveals home and backgrounds
    // this activity, so note the unlock and re-foreground it once the dismiss settles (a re-launch mid-dismiss
    // paints a black window). Only while the user hasn't dismissed it with Back/Home.
    private val keyguardUnlock: Any? =
        if (android.os.Build.VERSION.SDK_INT >= 34)
            KeyguardManager.KeyguardLockedStateListener { locked ->
                if (!locked) {
                    lastUnlockedAt = System.currentTimeMillis()
                    if (!leaving && !sentAway && !isFinishing) {
                        val r = Runnable {
                            unlockReShowRunnable = null
                            if (!leaving && !sentAway && !isFinishing) runCatching {
                                startActivity(launchIntent(this@LockPlayerActivity))
                                CarLog.lockPlayer(this@LockPlayerActivity, "stays up after unlock")
                            }
                        }
                        unlockReShowRunnable = r
                        mainHandler.postDelayed(r, 450)
                    }
                }
            }
        else null
    /** Set when the player goes because the user dismissed it (Back/Home): nothing brings it back then. */
    private var leaving = false
    private fun leaving(why: String) {
        leaving = true
        CarLog.lockPlayer(this, "closes: $why")
    }

    /**
     * Dismissing the player returns to whatever was open before it -- the app the user was in, or the home
     * screen -- never forcing Hive forward. moveTaskToBack sends the player's task behind the one it covered.
     */
    private fun dismissToPrevious() {
        runCatching { moveTaskToBack(true) }
    }
    /** When the player last came to the front. */
    private var resumedAt = 0L
    /** When the player was last touched (or came up): left alone, the screen should go off. */
    private var touchedAt = 0L
    private val idleWatch = object : Runnable {
        override fun run() {
            val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
            // The player no longer closes itself on unlock -- it stays until the user dismisses it. The one
            // automatic exit is this: left untouched well past the lock screen's own timeout, step aside so
            // the screen can sleep (the phone may not sleep a foreign window the way it sleeps its lock
            // screen). In the car the phone stays on while it charges, so there the player stays up.
            if (awake && !leaving && System.currentTimeMillis() - touchedAt > SLEEP_AFTER_MS + IDLE_GRACE_MS) {
                CarLog.lockPlayer(this@LockPlayerActivity, "left idle, stepping aside so the screen can sleep")
                dismissToPrevious()
                if (activeInstance === this@LockPlayerActivity) activeInstance = null
                finishAndRemoveTask()
                return
            }
            mainHandler.postDelayed(this, 1_000)
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
            if ((locked || CarLog.inCar(this)) && !leaving && !isFinishing) { CarLog.lockPlayer(this, "call over, comes back"); showIfWanted(this) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        setShowWhenLocked(true)
        if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        @Suppress("DEPRECATION")
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
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
        if (android.os.Build.VERSION.SDK_INT >= 34 && keyguardUnlock != null) runCatching {
            (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).addKeyguardLockedStateListener(
                ContextCompat.getMainExecutor(this), keyguardUnlock as KeyguardManager.KeyguardLockedStateListener,
            )
        }
        activeInstance = this
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() = dismissToBack() })
        setContent { HiveThemed(vm) { LockPlayer(vm, onUnlock = ::unlock) } }
        if (android.os.Build.VERSION.SDK_INT >= 31) getSystemService(android.media.AudioManager::class.java)
            .addOnModeChangedListener(ContextCompat.getMainExecutor(this), callWatch as android.media.AudioManager.OnModeChangedListener)
        CarLog.lockPlayer(this, "opens")
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        setShowWhenLocked(true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setShowWhenLocked(true)
        leaving = false
    }

    /**
     * User navigation away from the lock player (Home, Recents / Overview square button, or app switch):
     * The player immediately dismisses and removes its task from Recents.
     * It stays dismissed until the phone next sleeps and wakes.
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!resumed) {
            CarLog.lockPlayer(this, "ignore spurious onUserLeaveHint: not resumed")
            return
        }
        val now = System.currentTimeMillis()
        if (now - resumedAt < HOME_AFTER_MS) {
            CarLog.lockPlayer(this, "ignore spurious onUserLeaveHint: resumed only ${now - resumedAt}ms ago")
            return
        }
        unlockReShowRunnable?.let { mainHandler.removeCallbacks(it) }
        unlockReShowRunnable = null
        mainHandler.removeCallbacksAndMessages(null)
        sentAway = true
        leaving("user left (home/recents pressed)")
        dismissToPrevious()
        if (activeInstance === this) activeInstance = null
        finishAndRemoveTask()
    }

    override fun onResume() {
        super.onResume()
        setShowWhenLocked(true)
        resumed = true
        resumedAt = System.currentTimeMillis()
        touchedAt = resumedAt
        sentAway = false
        mainHandler.removeCallbacks(idleWatch)
        mainHandler.postDelayed(idleWatch, 1_000)
        // Never over a call: the phone's call screen comes first.
        if (inCall(this)) { steppedAside = true; moveTaskToBack(true); return }
    }

    override fun onPause() {
        super.onPause()
        resumed = false
    }

    /**
     * When the activity stops:
     * - If the screen is turning off / sleeping, finish cleanly so the display sleeps peacefully.
     * - If the phone is unlocked, clean up completely.
     * - Under NO circumstances do we call startActivity here, which would abort screen-off and cause wake loops!
     */
    override fun onStop() {
        super.onStop()
        mainHandler.removeCallbacks(idleWatch)
        if (leaving || isFinishing || isChangingConfigurations) return
        val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
        val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        val isLocked = km.isKeyguardLocked || km.inKeyguardRestrictedInputMode() || km.isDeviceLocked
        CarLog.lockPlayer(this, "stopped; isLocked=$isLocked, awake=$awake")
        if (!awake) {
            // Screen went to sleep: finish cleanly so next wake starts completely fresh
            if (activeInstance === this) activeInstance = null
            finishAndRemoveTask()
            return
        }
        if (!isLocked) {
            // Phone is unlocked and the user navigated away (Recents, Home, app switch):
            // Dismiss and remove task completely so it never lingers or shows in Recents.
            if (unlockReShowRunnable == null) {
                sentAway = true
                leaving("stopped while unlocked (navigated away)")
                if (activeInstance === this) activeInstance = null
                finishAndRemoveTask()
            }
            return
        }
    }

    /**
     * Back: dismiss the player to whatever was behind it -- the app that was open before it (if the phone
     * is unlocked), or the lock screen (if still locked). It stays away until the phone next sleeps and
     * wakes ([screenChanged] clears sentAway and the screen-on signal re-shows it), so re-locking brings it
     * back. Same effect as Home.
     */
    private fun dismissToBack() {
        unlockReShowRunnable?.let { mainHandler.removeCallbacks(it) }
        unlockReShowRunnable = null
        mainHandler.removeCallbacksAndMessages(null)
        sentAway = true
        leaving("back: to previous app / lock screen")
        dismissToPrevious()
        if (activeInstance === this) activeInstance = null
        finishAndRemoveTask()
    }

    private fun unlock() {
        unlockReShowRunnable?.let { mainHandler.removeCallbacks(it) }
        unlockReShowRunnable = null
        mainHandler.removeCallbacksAndMessages(null)
        sentAway = true
        if (activeInstance === this) activeInstance = null
        // Already unlocked (face unlock): dismiss straight to whatever was open before, no keyguard request.
        if (!(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) {
            dismissToPrevious(); leaving("unlock: to previous"); finishAndRemoveTask()
            return
        }
        (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { dismissToPrevious(); leaving("swiped up: to previous"); finishAndRemoveTask() }
        })
    }

    override fun onDestroy() {
        if (activeInstance === this) activeInstance = null
        unlockReShowRunnable?.let { mainHandler.removeCallbacks(it) }
        mainHandler.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(unlocked) }
        if (android.os.Build.VERSION.SDK_INT >= 34 && keyguardUnlock != null) runCatching {
            (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).removeKeyguardLockedStateListener(keyguardUnlock as KeyguardManager.KeyguardLockedStateListener)
        }
        if (android.os.Build.VERSION.SDK_INT >= 31) runCatching {
            getSystemService(android.media.AudioManager::class.java).removeOnModeChangedListener(callWatch as android.media.AudioManager.OnModeChangedListener)
        }
        super.onDestroy()
    }

    companion object {
        @Volatile private var activeInstance: LockPlayerActivity? = null
        /** When the keyguard last unlocked (face/fingerprint). Kept in companion so it survives activity recreation. */
        @Volatile var lastUnlockedAt = 0L
        /** Home or Back pressed on the player: it stays away until the phone next goes to sleep (see [screenChanged]). */
        @Volatile private var sentAway = false
        /** The player is on screen right now (between onResume and onPause). When it is NOT, a re-show must
         *  start a FRESH activity, because Android 16+ refuses to bring a backgrounded one to the front
         *  (background-activity-launch) -- the "shows once then never again" bug. See [showIfWanted]. */
        @Volatile private var resumed = false

        /** The screen went off or came on: a player sent away with Home/Back may show again. */
        // A real screen on/off is a genuine wake, not the launch re-triggering itself, so clear the anti-loop
        // cooldown too -- otherwise locking and waking within 5s was refused with "shown a moment ago".
        fun screenChanged() {
            sentAway = false
            lastShowAttemptAt = 0L
            screenChangedAt = System.currentTimeMillis()
            activeInstance?.let {
                if (!resumed && !it.isFinishing) {
                    it.finishAndRemoveTask()
                }
            }
            activeInstance = null
        }
        /** When the screen last went off or came on. */
        @Volatile private var screenChangedAt = 0L
        /** Android Auto takes the screen over as the phone wakes; later than this, what pushed the player away was the user. */
        private const val CAR_TAKEOVER_MS = 5_000L
        private const val PREF = "lock-player"
        /** When showIfWanted last actually tried to raise the player. */
        @Volatile private var lastShowAttemptAt = 0L
        /** Ignore a fresh show this soon after the last: prevents intent looping on rapid wake events. */
        private const val SHOW_COOLDOWN_MS = 1_000L
        private const val HOME_AFTER_MS = 250L
        /** The lock screen's own screen timeout. */
        private const val SLEEP_AFTER_MS = 10_000L
        /** How long past [SLEEP_AFTER_MS] the screen may stay on before the player steps aside for the lock screen. */
        private const val IDLE_GRACE_MS = 5_000L

        /**
         * Whether Hive's own UI was the app in use when the player last came up. Only then does unlocking
         * bring Hive forward; otherwise unlocking returns to whatever app the user was really in.
         */
        @Volatile private var hiveWasForeground = false

        /** Whether Hive shows itself over the lock screen while music plays. */
        fun enabled(context: Context) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean(PREF, false)
        fun setEnabled(context: Context, on: Boolean) = context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean(PREF, on).apply()

        /** Android lets an app open a screen from the background only with "Display over other apps". */
        fun permitted(context: Context) = Settings.canDrawOverlays(context)

        /** A call ringing or on (phone, or a call app like WhatsApp): the phone's sound is set for calls then. */
        fun inCall(context: Context) = (context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager).mode != android.media.AudioManager.MODE_NORMAL

        /**
         * Called as the screen comes on locked.
         */
        private fun launchIntent(context: Context): Intent =
            Intent(context, LockPlayerActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
                .apply { if (!resumed || activeInstance == null || activeInstance?.isFinishing == true) addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK) }

        fun showIfWanted(context: Context, hiveForeground: Boolean = hiveWasForeground, freshWake: Boolean = false) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
            if (pm?.isInteractive != true) {
                CarLog.lockPlayer(context, "not shown: screen is off")
                return
            }
            if (freshWake) {
                sentAway = false
                lastShowAttemptAt = 0L
            }
            if (resumed) {
                CarLog.lockPlayer(context, "already on screen")
                return
            }
            val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            val isLocked = km?.isKeyguardLocked == true || km?.inKeyguardRestrictedInputMode() == true || km?.isDeviceLocked == true
            val blocked = when {
                !enabled(context) -> "disabled in settings"
                !permitted(context) -> "no draw-over-other-apps permission"
                inCall(context) -> "a call is in progress"
                sentAway -> "the user sent it away"
                !isLocked -> "phone is unlocked"
                System.currentTimeMillis() - lastShowAttemptAt < SHOW_COOLDOWN_MS -> "shown a moment ago"
                else -> null
            }
            if (blocked != null) { CarLog.lockPlayer(context, "not shown: $blocked"); return }
            lastShowAttemptAt = System.currentTimeMillis()
            hiveWasForeground = hiveForeground
            val open = launchIntent(context)
            val options = android.app.ActivityOptions.makeBasic()
            if (android.os.Build.VERSION.SDK_INT >= 34) {
                options.setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
            }
            val direct = runCatching { context.startActivity(open, options.toBundle()) }
            CarLog.lockPlayer(context, "startActivity ${if (direct.isSuccess) "sent" else "refused: ${direct.exceptionOrNull()?.message}"}")
        }

    }
}
