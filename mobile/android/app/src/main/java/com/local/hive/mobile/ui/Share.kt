package com.local.hive.mobile.ui

import android.content.ClipData
import android.content.Context
import android.content.Intent
import com.local.hive.mobile.data.Track

/** Sharing as Samsung Music does it: the song files themselves, through Android's share sheet. */
object Share {
    fun tracks(context: Context, tracks: List<Track>) {
        if (tracks.isEmpty()) return
        val uris = tracks.map { it.uri }
        val intent = if (uris.size == 1) {
            Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
        } else {
            Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        }
        intent.type = "audio/*"
        // The receiving app reads the files through this grant; nothing else on the phone opens up.
        val label = if (tracks.size == 1) tracks[0].title else countOf(tracks.size, "song")
        intent.clipData = ClipData(label, arrayOf("audio/*"), ClipData.Item(uris[0])).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        intent.putExtra(Intent.EXTRA_TITLE, label)
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(intent, if (tracks.size == 1) "Share “${tracks[0].title}”" else "Share ${countOf(tracks.size, "song")}"))
    }

    /** A link or a line of text, for songs that live on a service rather than the phone. */
    fun text(context: Context, text: String, title: String) {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        context.startActivity(Intent.createChooser(intent, title))
    }
}
