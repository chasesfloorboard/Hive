package com.local.hive.mobile.playback

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The last drive, kept until the next one: what Android Auto asked of Hive,
 * what Hive's lock-screen player did, one line each (car-log.txt), and
 * Android Auto's own system log for the whole drive (car-logcat.txt). A new
 * drive (Android Auto connecting after a while away) starts both afresh, so
 * only the latest drive is ever kept. In the app's external files folder,
 * readable over USB; Android's own log forgets within hours, these don't.
 */
object CarLog {
    private const val TAG = "HiveCar"
    private const val MAX_BYTES = 512 * 1024L
    private const val MAX_CAPTURE_BYTES = 8 * 1024 * 1024L
    private const val ANDROID_AUTO = "com.google.android.projection.gearhead"
    /** Android Auto connecting this long after the last car line is a new drive. */
    private const val NEW_DRIVE_MS = 15 * 60_000L
    /** The system log capture stops this long after Android Auto leaves (or after 4 hours). */
    private const val AFTER_DRIVE_MS = 2 * 60_000L
    private const val LONGEST_DRIVE_MS = 4 * 60 * 60_000L
    @Volatile private var capturing = false
    @Volatile private var disconnectedAt = 0L

    private fun file(context: Context, name: String) = context.getExternalFilesDir(null)?.let { File(it, name) }

    /** A new drive: the last drive's logs go, this one's start. */
    private fun startDrive(context: Context) {
        listOf("car-log.txt", "car-logcat.txt", "car-logcat-previous.txt").forEach { name -> file(context, name)?.delete() }
        write(context, "drive starts")
    }

    /**
     * Android Auto's own log for the whole drive, into car-logcat.txt, so the reason
     * it won't show Hive is kept after the drive. Needs READ_LOGS, granted over USB
     * (adb shell pm grant com.local.hive.mobile android.permission.READ_LOGS); Android may ask once.
     */
    private fun captureCarLog(context: Context) {
        if (capturing || context.checkSelfPermission(android.Manifest.permission.READ_LOGS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        val out = file(context, "car-logcat.txt") ?: return
        capturing = true
        Thread {
            runCatching {
                val proc = ProcessBuilder("logcat", "-v", "threadtime", "-T", "1").redirectErrorStream(true).start()
                val started = System.currentTimeMillis()
                // Ends a while after Android Auto leaves, at the longest drive, or when the file is full.
                Thread {
                    while (proc.isAlive) {
                        Thread.sleep(30_000)
                        val now = System.currentTimeMillis()
                        val gone = !carConnected && disconnectedAt > 0 && now - disconnectedAt > AFTER_DRIVE_MS
                        if (gone || now - started > LONGEST_DRIVE_MS || out.length() > MAX_CAPTURE_BYTES) proc.destroy()
                    }
                }.apply { isDaemon = true }.start()
                java.io.FileWriter(out, true).buffered().use { w ->
                    proc.inputStream.bufferedReader().useLines { lines ->
                        for (line in lines) if (KEEP.containsMatchIn(line)) { w.write(line); w.newLine(); w.flush() }
                    }
                }
            }
            capturing = false
        }.apply { isDaemon = true }.start()
    }
    private val KEEP = Regex("GH\\.|CAR\\.|gearhead|HiveCar|com\\.local\\.hive|MediaBrowser|MediaSession|AndroidRuntime")

    /** Android Auto is connected to Hive's session: the phone is in the car. */
    @Volatile var carConnected = false
    @Volatile private var carControllers = 0

    /** The phone is in the car: Android Auto connected to Hive, or the phone in car mode. */
    fun inCar(context: Context) = carConnected ||
        (context.getSystemService(android.app.UiModeManager::class.java)?.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_CAR)

    /** Android Auto came or went (its controller connected to or left Hive's session). */
    fun car(context: Context, caller: String, connected: Boolean) {
        if (caller != ANDROID_AUTO) return
        // Android Auto connects several controllers; the car is gone when the last of them is.
        carControllers = (carControllers + if (connected) 1 else -1).coerceAtLeast(0)
        carConnected = carControllers > 0
        if (!connected) { disconnectedAt = System.currentTimeMillis(); note(context, caller, "disconnect") }
    }

    /** What Hive's lock-screen player did, and the phone's lock state then, for when it doesn't stay up. */
    fun lockPlayer(context: Context, event: String) {
        val km = context.getSystemService(android.app.KeyguardManager::class.java)
        val pm = context.getSystemService(android.os.PowerManager::class.java)
        write(context, "lock player $event (keyguard ${if (km?.isKeyguardLocked == true) "up" else "down"}, ${if (km?.isDeviceLocked == true) "locked" else "unlocked"}, screen ${if (pm?.isInteractive == true) "on" else "off"}, car ${inCar(context)})")
    }

    fun note(context: Context, caller: String, event: String) {
        // Hive's own screens and the system UI connect all the time; only other apps are worth keeping.
        if (caller == context.packageName) return
        if (caller == ANDROID_AUTO && event.startsWith("connect")) {
            val last = file(context, "car-log.txt")?.takeIf { it.exists() }?.lastModified() ?: 0L
            if (!carConnected && System.currentTimeMillis() - last > NEW_DRIVE_MS) startDrive(context)
            captureCarLog(context)
        }
        write(context, "$caller $event")
    }

    private fun write(context: Context, what: String) {
        val line = "${SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())} $what"
        Log.i(TAG, line)
        runCatching {
            val file = file(context, "car-log.txt") ?: return
            if (file.length() > MAX_BYTES) file.writeText(file.readLines().takeLast(2000).joinToString("\n", postfix = "\n"))
            file.appendText(line + "\n")
        }
    }
}
