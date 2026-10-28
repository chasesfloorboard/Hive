package com.local.hive.mobile.stream

import android.content.Context
import android.content.Intent

/**
 * Downloads through Seeker, the Soulseek app: Hive hands it the album (or
 * song) to search for and Seeker opens its search with it, where the files
 * are picked. Seeker saves into Music/Soulseek Complete, which the phone's
 * music index (and so Hive's library) picks up; song sync then sends the new
 * songs to Hive on the PC on Wi-Fi.
 */
object Seeker {
    const val PACKAGE = "com.companyname.andriodapp1"

    fun installed(context: Context) = runCatching { context.packageManager.getPackageInfo(PACKAGE, 0) }.isSuccess

    /**
     * Opens Seeker's search on [query]. Seeker takes the words only from the
     * shares it knows, so they go as a SoundCloud share's subject
     * ("<words> - SoundCloud"), which it reads as the words alone.
     */
    fun search(context: Context, query: String): Boolean {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").setPackage(PACKAGE)
            .putExtra(Intent.EXTRA_SUBJECT, "$query - SoundCloud")
            .putExtra(Intent.EXTRA_TEXT, query)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(send) }.isSuccess
    }

    private val edition = Regex("""\s*[(\[][^)\]]*(deluxe|remaster|edition|expanded|explicit|anniversary|bonus|version)[^)\]]*[)\]]""", RegexOption.IGNORE_CASE)
    private val release = Regex("""\s+-\s+(single|ep)$""", RegexOption.IGNORE_CASE)

    /** What to search Soulseek for: the first artist and the album as folders are named, without "(Deluxe Edition)" or " - EP". */
    fun albumQuery(artist: String, album: String): String {
        val who = artist.split(Regex(""",|&| feat\.? | x """, RegexOption.IGNORE_CASE)).first().trim()
        val what = album.replace(edition, "").replace(release, "").trim()
        return listOf(who, what).filter { it.isNotBlank() }.joinToString(" ")
    }
}
