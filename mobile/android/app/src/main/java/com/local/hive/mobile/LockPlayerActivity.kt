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
        // it, and only Back or Home sends it away. Kept registered (no-op) in case it is wanted again.
        override fun onReceive(context: Context, intent: Intent) {}
    }
    /** When the keyguard last unlocked (face/fingerprint): the spurious onUserLeaveHint it fires is ignored. */
    private var unlockedAt = 0L
    // Keep the player up across a face/fingerprint unlock. The keyguard dismiss reveals home and backgrounds
    // this activity, so note the unlock and re-foreground it once the dismiss settles (a re-launch mid-dismiss
    // paints a black window). Only while the user hasn't dismissed it with Back/Home.
    private val keyguardUnlock: Any? =
        if (android.os.Build.VERSION.SDK_INT >= 34)
            KeyguardManager.KeyguardLockedStateListener { locked ->
                if (!locked) {
                    unlockedAt = System.currentTimeMillis()
                    if (!leaving && !wentHome && !isFinishing) window.decorView.postDelayed({
                        if (!leaving && !wentHome && !isFinishing) runCatching {
                            startActivity(launchIntent(this@LockPlayerActivity))
                            CarLog.lockPlayer(this@LockPlayerActivity, "stays up after unlock")
                        }
                    }, 450)
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
    /** When the player last came to the front, and whether the user then sent it away with Home. */
    private var resumedAt = 0L
    private var wentHome = false
    /** When the player was last touched (or came up): left alone, the screen should go off. */
    private var touchedAt = 0L
    private val idleWatch = object : Runnable {
        override fun run() {
            val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
            // The player no longer closes itself on unlock -- it stays until the user dismisses it. The one
            // automatic exit is this: left untouched well past the lock screen's own timeout, step aside so
            // the screen can sleep (the phone may not sleep a foreign window the way it sleeps its lock
            // screen). In the car the phone stays on while it charges, so there the player stays up.
            if (awake && !leaving && !CarLog.inCar(this@LockPlayerActivity) && System.currentTimeMillis() - touchedAt > SLEEP_AFTER_MS + IDLE_GRACE_MS) {
                CarLog.lockPlayer(this@LockPlayerActivity, "left idle, stepping aside so the screen can sleep")
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
            if ((locked || CarLog.inCar(this)) && !leaving && !isFinishing) { CarLog.lockPlayer(this, "call over, comes back"); showIfWanted(this) }
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
        if (android.os.Build.VERSION.SDK_INT >= 34 && keyguardUnlock != null) runCatching {
            (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).addKeyguardLockedStateListener(
                ContextCompat.getMainExecutor(this), keyguardUnlock as KeyguardManager.KeyguardLockedStateListener,
            )
        }
        // Back closes the player to reveal the lock screen and its notifications (the phone stays
        // locked); it comes back when the phone next sleeps and wakes. Swiping up still unlocks.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() = dismissToBack() })
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
        // A face/fingerprint unlock fires a spurious onUserLeaveHint as the keyguard dismisses -- ignore it so
        // an unlock is never taken as a Home press that sends the player away. A real Home press comes well
        // after any unlock. (In the car, Android Auto's takeover on wake looks the same, hence the resume
        // guard too.)
        if (System.currentTimeMillis() - unlockedAt < HOME_AFTER_MS) return
        if (CarLog.inCar(this) && System.currentTimeMillis() - resumedAt < HOME_AFTER_MS) return
        wentHome = true; sentAway = true; CarLog.lockPlayer(this, "home pressed")
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        // In the car the phone is plugged in and mounted: keep the screen on so the player stays visible for the
        // whole drive instead of being dropped when the screen sleeps. Off-car, let it sleep like the lock screen.
        if (CarLog.inCar(this)) window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        resumedAt = System.currentTimeMillis()
        touchedAt = resumedAt
        wentHome = false
        sentAway = false
        window.decorView.removeCallbacks(idleWatch)
        window.decorView.postDelayed(idleWatch, 1_000)
        // Never over a call: the phone's call screen comes first.
        if (inCall(this)) { steppedAside = true; moveTaskToBack(true); return }
        // The player used to finish itself here when the phone was already unlocked. It now stays after an
        // unlock (see the class doc), so that is gone -- Back/Home or the idle step-aside dismiss it.
    }

    override fun onPause() {
        super.onPause()
        resumed = false
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
        val awake = (getSystemService(POWER_SERVICE) as android.os.PowerManager).isInteractive
        CarLog.lockPlayer(this, "pushed away")
        // Come back only in the car and only while the screen is on. Don't require the keyguard to report
        // "locked": in the car the phone is held unlocked, so that check never passed and the player, once
        // pushed aside by Android Auto's takeover, never returned.
        if (!awake || !CarLog.inCar(this)) return
        // Only Android Auto's takeover as the phone wakes is undone. Anything later (Home, whether or
        // not Android reported it as Home, or an app the user opened) is the user's choice and stands.
        if (System.currentTimeMillis() - screenChangedAt > CAR_TAKEOVER_MS) return
        val now = System.currentTimeMillis()
        broughtBack.removeAll { now - it > 60_000 }
        if (broughtBack.size >= 3) return
        broughtBack += now
        window.decorView.postDelayed({ CarLog.lockPlayer(this, "comes back"); showIfWanted(this) }, 400)
    }

    /**
     * Back: dismiss the player to whatever was behind it -- the app that was open before it (if the phone
     * is unlocked), or the lock screen (if still locked). It stays away until the phone next sleeps and
     * wakes ([screenChanged] clears sentAway and the screen-on signal re-shows it), so re-locking brings it
     * back. Same effect as Home.
     */
    private fun dismissToBack() {
        wentHome = true
        sentAway = true
        CarLog.lockPlayer(this, "back: to previous app / lock screen")
        runCatching { moveTaskToBack(true) }
    }

    private fun unlock() {
        // Already unlocked (face unlock): dismiss straight to whatever was open before, no keyguard request.
        if (!(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) {
            dismissToPrevious(); leaving("unlock: to previous"); finish()
            return
        }
        (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { dismissToPrevious(); leaving("swiped up: to previous"); finish() }
        })
    }

    override fun onDestroy() {
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
        /** When the player was last brought back after being pushed away (see onStop). */
        private val broughtBack = mutableListOf<Long>()
        /** Home pressed on the player: it stays away until the phone next goes to sleep or wakes (see [screenChanged]). */
        @Volatile private var sentAway = false
        /** The player is on screen right now (between onResume and onPause). When it is NOT, a re-show must
         *  start a FRESH activity, because Android 16+ refuses to bring a backgrounded one to the front
         *  (background-activity-launch) -- the "shows once then never again" bug. See [showIfWanted]. */
        @Volatile private var resumed = false

        /** The screen went off or came on: a player sent away with Home may show again. */
        // A real screen on/off is a genuine wake, not the launch re-triggering itself, so clear the anti-loop
        // cooldown too -- otherwise locking and waking within 5s was refused with "shown a moment ago".
        fun screenChanged() { sentAway = false; lastShowAttemptAt = 0L; screenChangedAt = System.currentTimeMillis() }
        /** When the screen last went off or came on. */
        @Volatile private var screenChangedAt = 0L
        /** Android Auto takes the screen over as the phone wakes; later than this, what pushed the player away was the user. */
        private const val CAR_TAKEOVER_MS = 5_000L
        private const val PREF = "lock-player"
        /** When showIfWanted last actually tried to raise the player. */
        @Volatile private var lastShowAttemptAt = 0L
        /** Ignore a fresh show this soon after the last: the launch/full-screen-intent wakes the screen, and
         *  that wake would otherwise re-trigger showIfWanted on SCREEN_ON and loop. A real later wake still shows it. */
        private const val SHOW_COOLDOWN_MS = 5_000L
        private const val HOME_AFTER_MS = 2_000L
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
         * Called as the screen goes off or comes on locked, or as music starts on a locked phone.
         * [hiveForeground] records whether Hive's own UI was the app in use, which decides where a later
         * unlock lands; a call coming back (no fresh signal) keeps the value from when the player first showed.
         */
        /** The intent that raises the player -- EVERY launch site goes through this. When the player is NOT
         *  already on screen, CLEAR_TASK makes it a FRESH start: Android 16+ refuses to bring a backgrounded
         *  activity to the front, so a plain re-launch (a reorder) silently does nothing -- the "shows once,
         *  then never again" bug. A fresh start is the one launch Android still allows. When the player IS on
         *  screen (a re-show on a song change), no CLEAR_TASK, so it is not needlessly recreated / flickered. */
        private fun launchIntent(context: Context): Intent =
            Intent(context, LockPlayerActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
                .apply { if (!resumed) addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK) }

        fun showIfWanted(context: Context, hiveForeground: Boolean = hiveWasForeground) {
            // Each of these used to return silently, so a drive where the player never came up left no clue
            // which gate closed. Name the reason in the car log.
            val blocked = when {
                !enabled(context) -> "disabled in settings"
                !permitted(context) -> "no draw-over-other-apps permission"
                inCall(context) -> "a call is in progress"
                sentAway -> "the user sent it away"
                // Off-car only: the car re-shows itself quickly to undo an Android Auto takeover (its own
                // comes-back path, rate-limited there), so the phone's anti-loop cooldown must not block it.
                // (No "already up" guard: that flag could wedge stuck-true under Android Auto's screen churn
                // and then refuse every later wake. The no-launch-on-SCREEN_OFF change already breaks the loop.)
                !CarLog.inCar(context) && System.currentTimeMillis() - lastShowAttemptAt < SHOW_COOLDOWN_MS -> "shown a moment ago"
                else -> null
            }
            if (blocked != null) { CarLog.lockPlayer(context, "not shown: $blocked"); return }
            lastShowAttemptAt = System.currentTimeMillis()
            hiveWasForeground = hiveForeground
            val open = launchIntent(context)
            // The player is raised ONLY by this direct launch, which works from a locked, screen-on phone
            // (the only time we launch — SCREEN_ON while locked, or music starting with the screen on). There
            // is deliberately no full-screen-intent fallback: that posted a "Hive" push notification showing
            // the song, which the user never wants. If a launch is ever refused the player just doesn't show
            // that time; the standard media notification still carries the controls on the lock screen.
            val direct = runCatching { context.startActivity(open) }
            CarLog.lockPlayer(context, "startActivity ${if (direct.isSuccess) "sent" else "refused: ${direct.exceptionOrNull()?.message}"}")
        }

    }
}
