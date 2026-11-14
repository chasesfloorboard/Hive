package com.local.hive.mobile

import com.local.hive.mobile.discovery.LyricsStore
import com.local.hive.mobile.data.ScrobblerPort
import com.local.hive.mobile.data.StreamingGateway
import com.local.hive.mobile.data.YouTubeMusicPort
import kotlinx.coroutines.launch

/**
 * Hive Mobile — the full F-Droid edition. It adds the Apple Music / Spotify / Soulseek / YouTube Music /
 * Scrobbler services on top of the shared [HiveAppBase] (which already carries the compliant discovery tier
 * used by both editions), and keeps self-update from the paired PC.
 */
class HiveApp : HiveAppBase(), com.local.hive.mobile.soulseek.SoulseekHost {
    val appleMusic by lazy { com.local.hive.mobile.stream.AppleMusic() }
    val spotify by lazy { com.local.hive.mobile.stream.Spotify() }
    val spotifyAccount by lazy { com.local.hive.mobile.stream.SpotifyAccount(this) }
    val appleAccount by lazy { com.local.hive.mobile.stream.AppleAccount(this) }
    /** Genius lyrics — the Mobile-only fallback, tried only when LRCLIB has nothing synced. */
    val genius by lazy { com.local.hive.mobile.stream.GeniusLyrics() }

    // Concrete YouTubeMusic — satisfies both the base's YouTubeMusicPort and SoulseekHost's YouTubeMusic.
    override val youTubeMusic: com.local.hive.mobile.stream.YouTubeMusic by lazy { com.local.hive.mobile.stream.YouTubeMusic(this) }
    // Concrete Scrobbler — the Settings scrobble section reads its settings/queue beyond the port.
    override val scrobbler: com.local.hive.mobile.stream.Scrobbler by lazy { com.local.hive.mobile.stream.Scrobbler(this) }
    /** The library re-scan trigger Soulseek asks for after a download lands (SoulseekHost). */
    override val rescan: com.local.hive.mobile.data.RescanTrigger get() = this
    override val streamingGateway: StreamingGateway by lazy { AppStreamingGateway(spotify, appleMusic) }
    override val lyricsStore: LyricsStore by lazy { com.local.hive.mobile.discovery.LyricsStore(this, fallback = { a, t -> genius.find(a, t) }) }
    override val selfUpdates: Boolean get() = true

    /** Soulseek downloads: queued, coming in, and the latest done (SoulseekHost). */
    override val downloads by lazy { com.local.hive.mobile.soulseek.Downloads(this) }

    /** The Apple Music / Spotify view-model surface, used only by the Mobile streaming screens. */
    val streamingVm by lazy { com.local.hive.mobile.ui.StreamingVm(this) }

    override fun onCreate() {
        super.onCreate()
        // Pick up any Soulseek download that didn't finish, so a reboot/restart resumes them on its own and
        // the user never has to go re-find the album. Off the main thread (it reads the saved download list).
        scope.launch { runCatching { com.local.hive.mobile.soulseek.SoulseekWorker.resumeUnfinished(this@HiveApp) } }
    }
}
