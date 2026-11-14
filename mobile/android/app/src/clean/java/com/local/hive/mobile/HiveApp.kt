package com.local.hive.mobile

import com.local.hive.mobile.data.NoScrobbler
import com.local.hive.mobile.data.NoStreamingGateway
import com.local.hive.mobile.data.NoYouTubeMusic
import com.local.hive.mobile.data.ScrobblerPort
import com.local.hive.mobile.data.StreamingGateway
import com.local.hive.mobile.data.YouTubeMusicPort
import com.local.hive.mobile.discovery.LyricsStore

/**
 * Hive Clean — the strict Google Play edition. It is [HiveAppBase] with no streaming services at all:
 * :streaming and :soulseek are absent from this build. Apple Music, Spotify, YouTube Music, Scrobbling,
 * Genius and Soulseek are no-ops; everything compliant (local library, covers, MusicBrainz metadata, lrclib
 * lyrics, radio, podcasts, Deezer artist images) comes from the shared base and the :core/discovery tier.
 */
class HiveApp : HiveAppBase() {
    override val youTubeMusic: YouTubeMusicPort get() = NoYouTubeMusic
    override val scrobbler: ScrobblerPort get() = NoScrobbler
    override val streamingGateway: StreamingGateway get() = NoStreamingGateway
    /** LRCLIB only — no Genius fallback in the Play edition. */
    override val lyricsStore: LyricsStore by lazy { LyricsStore(this) }
    /** Google Play forbids an app installing APKs itself, so Clean never self-updates. */
    override val selfUpdates: Boolean get() = false
}
