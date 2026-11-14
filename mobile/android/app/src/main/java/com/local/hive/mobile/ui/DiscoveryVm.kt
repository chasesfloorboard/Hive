package com.local.hive.mobile.ui

import com.local.hive.mobile.HiveApp

/**
 * The compliant, keyless discovery features shared by both editions — MusicBrainz album metadata and the
 * iTunes cover search (for the tag editor), LRCLIB lyrics, radio-browser radio, and the iTunes/RSS podcast
 * directory. Factored out of [MainViewModel] into its own holder so each concern lives on its own instead
 * of swelling the view-model god-object; [MainViewModel] still exposes them (via its `discovery` member and
 * thin delegates) so existing screens keep calling `vm.searchAlbums`, `vm.radio`, `vm.podcasts`, … unchanged.
 */
class DiscoveryVm(private val app: HiveApp) {
    // ---- album metadata (MusicBrainz) + cover search (iTunes) — keyless, for the tag editor ----
    private val metadata: com.local.hive.mobile.discovery.MetadataProvider = com.local.hive.mobile.discovery.MusicBrainzMetadata()
    // These do network I/O (MusicBrainz / iTunes), which routinely fails on a phone (offline, timeout). Catch
    // at this seam — discovery owns the providers — so a failure degrades to the empty "nothing found" state
    // the tag/cover/auto-tag screens already render, instead of throwing out of their LaunchedEffect and
    // crashing the app. (runCatchingNotCancelled still lets CancellationException through so leaving the
    // screen cancels cleanly.)
    suspend fun searchAlbums(query: String): List<com.local.hive.mobile.discovery.AlbumHit> =
        com.local.hive.mobile.data.runCatchingNotCancelled { metadata.searchAlbums(query) }.getOrDefault(emptyList())
    suspend fun albumDetails(id: String): com.local.hive.mobile.discovery.AlbumMeta? =
        com.local.hive.mobile.data.runCatchingNotCancelled { metadata.album(id) }.getOrNull()
    private val coverSearch = com.local.hive.mobile.discovery.ITunesCoverSearch()
    suspend fun searchCovers(query: String): List<com.local.hive.mobile.discovery.CoverChoice> =
        com.local.hive.mobile.data.runCatchingNotCancelled { coverSearch.search(query) }.getOrDefault(emptyList())

    // ---- lyrics (LRCLIB default, in :core; Genius is a Mobile-only fallback) ----
    suspend fun lyrics(now: com.local.hive.mobile.playback.NowPlaying) = app.lyricsStore.find(now.artist, now.title, now.album, now.durationMs)
    suspend fun saveOwnLyrics(artist: String, title: String, text: String) = app.lyricsStore.saveOwn(artist, title, text)

    // ---- radio (radio-browser.info, keyless) ----
    val radio get() = app.radio
    val savedStations = app.radioStore.saved
    fun toggleStation(s: com.local.hive.mobile.discovery.Station) = app.radioStore.toggle(s)
    fun playStation(s: com.local.hive.mobile.discovery.Station) = app.player.playMedia(listOf(s.toMediaItem()))

    // ---- podcasts (iTunes Search directory + RSS, keyless) ----
    val podcasts get() = app.podcasts
    val podcastSubscriptions = app.podcastStore.subscriptions
    val podcastProgress = app.podcastStore.progress
    fun togglePodcast(p: com.local.hive.mobile.discovery.Podcast) = app.podcastStore.toggle(p)
    fun markEpisode(e: com.local.hive.mobile.discovery.Episode, played: Boolean) =
        app.podcastStore.setProgress(e.mediaId, if (played) com.local.hive.mobile.discovery.PodcastStore.FINISHED else 0)
    /** Plays an episode, then the older ones after it, as a podcast app does. */
    fun playEpisodes(episodes: List<com.local.hive.mobile.discovery.Episode>, index: Int) =
        app.player.playMedia(episodes.drop(index).map { it.toMediaItem() })
}
