package com.local.hive.mobile.soulseek

import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.LinkStore
import com.local.hive.mobile.data.RescanTrigger
import com.local.hive.mobile.stream.YouTubeMusic

/**
 * Everything Soulseek downloading needs from the rest of the app, as one contract the composition
 * root (HiveApp) implements. The workers and the YouTube fallback cast applicationContext to this
 * instead of reaching into HiveApp, so :soulseek depends only on :core/:streaming/:sync/:playback.
 */
interface SoulseekHost {
    val downloads: Downloads
    val dao: LibraryDao
    val linkStore: LinkStore
    val youTubeMusic: YouTubeMusic
    /** Re-read the on-device library after a download lands (see RescanTrigger). */
    val rescan: RescanTrigger
}
