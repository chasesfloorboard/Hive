package com.local.hive.mobile.data

import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineExceptionHandler
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Hive's crash log, kept on this phone only. A crash (Hive closing) and an error caught in the
 * background (Hive carrying on) are each written as a small text file: what Hive was doing, never
 * songs, accounts or the music library. Nothing is sent anywhere: after a crash, Hive asks on its
 * next start whether to share the report, and the person chooses how (see CrashPrompt).
 */
object CrashLog {
    private const val KEEP = 40
    private const val PREFS = "crash-log"

    data class Entry(val file: File, val fatal: Boolean, val at: Long, val title: String)

    private fun dir(context: Context) = File(context.filesDir, "crashes").apply { mkdirs() }

    /** Records crashes (then lets Android close Hive as usual). Call once, first thing in Application.onCreate. */
    @Volatile private var installed: Context? = null

    fun install(context: Context) {
        val app = context.applicationContext
        installed = app
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { write(app, fatal = true, where = "thread ${thread.name}", error = error) }
            previous?.uncaughtException(thread, error)
        }
    }

    /**
     * For Hive's background work: an error there is written down and Hive carries on, instead of
     * the whole app closing because one background task failed.
     */
    fun handler(context: Context) = CoroutineExceptionHandler { ctx, error ->
        runCatching { write(context.applicationContext, fatal = false, where = ctx[kotlinx.coroutines.CoroutineName]?.name ?: "background work", error = error) }
        android.util.Log.e("Hive", "Background error (Hive carries on)", error)
    }

    /** The same, for code with no Context at hand (after [install]). */
    fun handler() = CoroutineExceptionHandler { _, error ->
        installed?.let { runCatching { write(it, fatal = false, where = "background work", error = error) } }
        android.util.Log.e("Hive", "Background error (Hive carries on)", error)
    }

    /** Writes one entry. Also used for errors worth keeping that were already handled. */
    fun write(context: Context, fatal: Boolean, where: String, error: Throwable) {
        val now = System.currentTimeMillis()
        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).let { "${it.versionName} (${it.longVersionCode})" } }.getOrDefault("?")
        val text = buildString {
            appendLine(if (fatal) "Hive Mobile closed unexpectedly" else "Hive Mobile: an error in the background (Hive carried on)")
            appendLine("When: ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(Date(now))}")
            appendLine("Hive Mobile: $version")
            appendLine("Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("Where: $where")
            appendLine()
            append(trace.take(24_000))
        }
        File(dir(context), "${if (fatal) "crash" else "error"}-$now.txt").writeText(text)
        prune(context)
    }

    private fun prune(context: Context) {
        dir(context).listFiles()?.sortedByDescending { it.lastModified() }?.drop(KEEP)?.forEach { it.delete() }
    }

    /** Every entry, newest first. */
    fun entries(context: Context): List<Entry> = dir(context).listFiles().orEmpty()
        .filter { it.name.endsWith(".txt") }
        .mapNotNull { f ->
            val fatal = f.name.startsWith("crash-")
            val at = f.name.substringAfter('-').substringBefore('.').toLongOrNull() ?: return@mapNotNull null
            val first = runCatching { f.useLines { lines -> lines.firstOrNull { it.startsWith("\t") || it.contains("Exception") || it.contains("Error:") } } }.getOrNull()
            Entry(f, fatal, at, first?.trim()?.take(120) ?: f.name)
        }
        .sortedByDescending { it.at }

    /** The newest crash not yet asked about (Hive asks once per crash). */
    fun unseenCrash(context: Context): Entry? {
        val seen = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("seenAt", 0)
        return entries(context).firstOrNull { it.fatal && it.at > seen }
    }

    fun markSeen(context: Context) {
        val newest = entries(context).firstOrNull()?.at ?: System.currentTimeMillis()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("seenAt", newest).apply()
    }

    fun clear(context: Context) { dir(context).listFiles()?.forEach { it.delete() }; markSeen(context) }

    /** Opens Android's share sheet with [entry]'s text; the person picks where it goes. */
    fun share(context: Context, entry: Entry) {
        val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(android.content.Intent.EXTRA_SUBJECT, "Hive Mobile ${if (entry.fatal) "crash" else "error"} report")
            putExtra(android.content.Intent.EXTRA_TEXT, runCatching { entry.file.readText() }.getOrDefault(""))
        }
        context.startActivity(android.content.Intent.createChooser(send, "Send the report").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
