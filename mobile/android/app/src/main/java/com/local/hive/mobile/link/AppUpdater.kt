package com.local.hive.mobile.link

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import com.local.hive.mobile.MainActivity
import com.local.hive.mobile.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

/**
 * Hive Mobile updates from Hive on the PC, over Hive Link: at home, or anywhere over Tailscale;
 * when the PC can't be reached (it's off), from Hive's GitHub release instead ([ONLINE]).
 * After a sync it asks the PC for its newest APK; a newer one is fetched in the background,
 * checked against the PC's checksum, and offered (a notification, and Settings). Installing it
 * asks the user once, as Android does for any app that isn't from a store.
 */
class AppUpdater(
    private val context: Context,
    private val client: HiveLinkClient,
    private val scope: CoroutineScope,
    /** Hive on the PC, when it can be reached: installing asks it for anything newer first. */
    private val connection: suspend () -> HiveLinkClient.Connection? = { null },
) {
    sealed interface State {
        data object UpToDate : State
        data class Downloading(val versionName: String) : State
        data class Ready(val versionName: String, val file: File) : State
        /** Handed to Android to install: further taps wait for it (it says when it's done, or that it was cancelled). */
        data class Installing(val versionName: String, val file: File) : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.UpToDate)
    val state: StateFlow<State> = _state.asStateFlow()
    private val lock = Mutex()
    private var lastCheck = 0L
    private val dir get() = File(context.cacheDir, "updates").apply { mkdirs() }

    val installedVersion: Long get() = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    val installedName: String get() = context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()

    /** Where an update comes from: Hive on the PC, or Hive's GitHub release. */
    private interface Source {
        suspend fun info(): AppUpdate?
        suspend fun download(out: java.io.OutputStream)
    }

    private fun pc(conn: HiveLinkClient.Connection) = object : Source {
        override suspend fun info() = client.appUpdate(conn)
        override suspend fun download(out: java.io.OutputStream) { client.downloadApp(conn, out) }
    }

    private val online = object : Source {
        // GitHub, with the system's ordinary certificate checks (Hive Link's own clients accept only the paired Hive's).
        private val http by lazy { okhttp3.OkHttpClient.Builder().connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS).readTimeout(120, java.util.concurrent.TimeUnit.SECONDS).build() }
        private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        override suspend fun info(): AppUpdate? = withContext(Dispatchers.IO) {
            http.newCall(okhttp3.Request.Builder().url("$ONLINE/HiveMobile.json").build()).execute().use { res ->
                if (res.code == 404) null
                else if (!res.isSuccessful) throw java.io.IOException("GitHub answered ${res.code}")
                else json.decodeFromString(AppUpdate.serializer(), res.body.string())
            }
        }
        override suspend fun download(out: java.io.OutputStream) = withContext(Dispatchers.IO) {
            http.newCall(okhttp3.Request.Builder().url("$ONLINE/HiveMobile.apk").build()).execute().use { res ->
                if (!res.isSuccessful) throw java.io.IOException("GitHub answered ${res.code}")
                res.body.byteStream().use { it.copyTo(out, 1 shl 16) }
            }
            Unit
        }
    }

    /** Asks the PC for a newer Hive Mobile (at most every few minutes unless [force]). */
    fun check(conn: HiveLinkClient.Connection, force: Boolean = false) = check(force) { pc(conn) }

    /**
     * Asks the PC when it can be reached, else GitHub, so updates arrive with the PC off too.
     * Called when Hive opens and from Settings' Check now.
     */
    fun checkAnywhere(force: Boolean = false) = check(force, fallback = online) { connection()?.let { pc(it) } ?: online }

    /**
     * [source] is tried first; if it fails and a [fallback] is given (and isn't the same source),
     * the fallback is tried before giving up. So "Check now" falls through to GitHub when the PC
     * can't be reached — including when a stale on-cable address (127.0.0.1) is still remembered.
     */
    private fun check(force: Boolean, fallback: Source? = null, source: suspend () -> Source) {
        scope.launch(Dispatchers.IO) {
            lock.withLock {
                if (!force && System.currentTimeMillis() - lastCheck < CHECK_EVERY_MS) return@withLock
                lastCheck = System.currentTimeMillis()
                val from = runCatching { source() }.getOrElse { online }
                val result = runCatching { fetch(from) }
                if (result.isFailure) {
                    if (fallback != null && from !== fallback) {
                        runCatching { fetch(fallback) }.onFailure { _state.value = State.Failed(it.message ?: "Couldn't reach GitHub") }
                    } else {
                        _state.value = State.Failed(result.exceptionOrNull()?.message ?: if (from === online) "Couldn't reach GitHub" else "Couldn't reach Hive on the PC")
                    }
                }
            }
        }
    }

    private suspend fun fetch(from: Source) {
        val update = from.info()
        if (update == null || update.versionCode <= installedVersion) {
            dir.listFiles()?.forEach { it.delete() }
            _state.value = State.UpToDate
            return
        }
        val file = File(dir, "HiveMobile-${update.versionCode}.apk")
        if (!(file.exists() && file.length() == update.size && sha256(file) == update.sha256)) {
            _state.value = State.Downloading(update.versionName)
            dir.listFiles()?.forEach { it.delete() }
            val part = File(dir, file.name + ".part")
            part.outputStream().use { from.download(it) }
            if (part.length() != update.size || sha256(part) != update.sha256) { part.delete(); throw IllegalStateException("The update didn't arrive whole; it'll try again.") }
            part.renameTo(file)
        }
        val wasReady = (_state.value as? State.Ready)?.file == file
        _state.value = State.Ready(update.versionName, file)
        if (!wasReady) notifyReady(update.versionName)
    }

    /**
     * Installs the newest update; Android shows its own confirmation. Call from a screen the user is on.
     * The PC is asked first, so an update published after this one was fetched is the one installed
     * (2.14.18 goes straight to 2.14.20, not through 2.14.19); away from the PC, the one fetched installs.
     */
    fun install(from: Context) {
        val asked = _state.value as? State.Ready ?: return
        // The first time, Android wants the user to let Hive install apps.
        if (!context.packageManager.canRequestPackageInstalls()) {
            from.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        // At once, so the button shows it's installing and a second tap does nothing.
        _state.value = State.Installing(asked.versionName, asked.file)
        notifyInstalling(asked.versionName)
        scope.launch(Dispatchers.IO) {
            lock.withLock { runCatching { connection()?.let { fetch(pc(it)) } } }
            val ready = (_state.value as? State.Ready) ?: (_state.value as? State.Installing)?.let { State.Ready(it.versionName, it.file) } ?: return@launch
            _state.value = State.Installing(ready.versionName, ready.file)
            runCatching {
                val installer = context.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(context.packageName)
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, ready.file.length()).use { out -> ready.file.inputStream().use { it.copyTo(out, 1 shl 16) }; session.fsync(out) }
                    val callback = PendingIntent.getBroadcast(context, id, Intent(context, InstallResult::class.java), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    session.commit(callback.intentSender)
                }
            }.onFailure { withContext(Dispatchers.Main) { installEnded(false, it.message ?: "The update couldn't be installed") } }
        }
    }

    /** What Android said: cancelled at its prompt (the update stays ready), or failed. Success replaces the app. */
    fun installEnded(cancelled: Boolean, message: String? = null) {
        val at = _state.value as? State.Installing ?: return
        context.getSystemService(NotificationManager::class.java).cancel(INSTALLING_ID)
        _state.value = if (cancelled) State.Ready(at.versionName, at.file) else State.Failed(message?.takeIf { it.isNotBlank() } ?: "The update couldn't be installed")
    }

    private fun notifyInstalling(versionName: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply { setShowBadge(false) })
        nm.cancel(NOTIFICATION_ID)
        nm.notify(INSTALLING_ID, NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hive)
            .setContentTitle("Installing Hive Mobile $versionName")
            .setContentText("Hive restarts when it's done.")
            .setProgress(0, 0, true)
            .setOngoing(true)
            .setSilent(true)
            .setTimeoutAfter(120_000)
            .build())
    }

    private fun notifyReady(versionName: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply { setShowBadge(false) })
        val open = PendingIntent.getActivity(context, 7, Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_INSTALL_UPDATE, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm.notify(NOTIFICATION_ID, NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_hive)
            .setContentTitle("Update available")
            .setContentText("Hive Mobile $versionName is ready. Tap to install.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build())
    }

    /** What Android says about an install: when it needs the user to confirm, it shows its screen. */
    class InstallResult : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                PackageInstaller.STATUS_SUCCESS -> context.getSystemService(NotificationManager::class.java).run { cancel(NOTIFICATION_ID); cancel(INSTALLING_ID) }
                else -> {
                    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                    android.util.Log.w("HiveUpdate", "install: $status $message")
                    (context.applicationContext as? com.local.hive.mobile.HiveApp)?.appUpdater?.installEnded(status == PackageInstaller.STATUS_FAILURE_ABORTED, message)
                }
            }
        }
    }

    companion object {
        private const val CHANNEL = "hive-updates"
        private const val NOTIFICATION_ID = 4711
        private const val INSTALLING_ID = 4714
        private const val CHECK_EVERY_MS = 10 * 60_000L
        /** Hive Mobile's own release on GitHub (tag "hive-mobile"): HiveMobile.json and HiveMobile.apk, replaced on each update. */
        const val ONLINE = "https://github.com/chasesfloorboard/Hive/releases/download/hive-mobile"
        private fun sha256(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { input -> val buf = ByteArray(1 shl 16); while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
