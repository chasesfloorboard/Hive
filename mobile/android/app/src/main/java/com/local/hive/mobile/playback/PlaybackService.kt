package com.local.hive.mobile.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.common.audio.AudioProcessor
import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import androidx.compose.ui.graphics.toArgb
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.MainActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Background playback: ExoPlayer inside a MediaSession, which gives Hive the
 * media notification, lock-screen and Bluetooth controls, and audio focus.
 * ExoPlayer plays queued local files back to back without a gap.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private val scope = MainScope()
    private lateinit var memory: PlaybackMemory
    private val equaliser = EqualiserProcessor()
    private val genre = MutableStateFlow("")
    private var lastPodcast: String? = null
    private var widgetJob: kotlinx.coroutines.Job? = null

    /** Redraws the home-screen widget, at most a few times a second. */
    private fun refreshWidget(player: Player) {
        val m = player.mediaMetadata
        val item = player.currentMediaItem?.mediaMetadata
        val state = com.local.hive.mobile.widget.WidgetState(
            title = (m.title ?: item?.station)?.toString().orEmpty(),
            artist = (m.artist ?: item?.station)?.toString().orEmpty(),
            art = (item?.artworkUri ?: m.artworkUri)?.toString(),
            playing = player.isPlaying,
            accent = (application as HiveApp).themes.colors.value.accent.toArgb(),
        )
        widgetJob?.cancel()
        widgetJob = scope.launch { delay(250); com.local.hive.mobile.widget.HiveWidget.update(this@PlaybackService, state) }
    }

    private fun savePodcast(player: Player, id: String) {
        val store = (application as HiveApp).podcastStore
        if (store.progress.value[id] == com.local.hive.mobile.stream.PodcastStore.FINISHED) return
        val duration = player.duration.takeIf { it > 0 }
        // Within the last half minute counts as finished.
        store.setProgress(id, if (duration != null && player.currentPosition > duration - 30_000) com.local.hive.mobile.stream.PodcastStore.FINISHED else player.currentPosition)
    }
    private val replayGainTags = MutableStateFlow<Map<String, String>>(emptyMap())
    private val queueTick = MutableStateFlow(0)

    override fun onCreate() {
        super.onCreate()
        val app = application as HiveApp
        // Streams from Hive on the PC carry the pairing token; nothing else does.
        val dataSources = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, DefaultHttpDataSource.Factory().setUserAgent("HiveMobile"))) { spec ->
            val pairing = app.linkStore.pairing
            val toPc = pairing != null && spec.uri.scheme == "http" && spec.uri.port == pairing.port && spec.uri.host in pairing.hosts
            if (toPc) spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer ${pairing!!.token}")) else spec
        }
        // Hive's equaliser runs inside the audio sink, ahead of every output.
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf<AudioProcessor>(equaliser)).build()
        }
        val player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        player.addListener(PlayCounter(app.playRecorder, app.scrobbler, scope, player))
        // Listens that couldn't be sent last time go now.
        scope.launch(Dispatchers.IO) { app.scrobbler.scrobble(null) }
        memory = PlaybackMemory(this, app.database.dao()) { ids -> app.pcLibrary.mediaItems(ids) }
        player.addListener(object : Player.Listener {
            // A song streamed through the PC that fails (PC gone, no match) falls back to its preview.
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                val item = player.currentMediaItem ?: return
                val preview = item.requestMetadata.extras?.getString(EXTRA_PREVIEW)?.takeIf { it.isNotBlank() } ?: return
                if (item.localConfiguration?.uri?.toString() == preview) return
                player.replaceMediaItem(player.currentMediaItemIndex, item.buildUpon().setUri(preview).build())
                player.prepare()
                player.play()
            }
            override fun onMediaMetadataChanged(mediaMetadata: androidx.media3.common.MediaMetadata) { genre.value = mediaMetadata.genre?.toString().orEmpty() }
            override fun onTracksChanged(tracks: androidx.media3.common.Tracks) { replayGainTags.value = ReplayGain.tagsOf(tracks); queueTick.value++ }
            // Podcast episodes pick up where they were left, and are marked done when played through.
            override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) lastPodcast?.let { app.podcastStore.setProgress(it, com.local.hive.mobile.stream.PodcastStore.FINISHED) }
                val id = mediaItem?.mediaId?.takeIf { it.startsWith("pod:") }
                lastPodcast = id
                val saved = id?.let { app.podcastStore.progress.value[it] } ?: 0
                if (saved > 5_000) player.seekTo(saved)
                // Playing a finished episode again starts it over.
                else if (id != null && saved == com.local.hive.mobile.stream.PodcastStore.FINISHED) app.podcastStore.setProgress(id, 0)
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) lastPodcast?.let { savePodcast(player, it) }
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) lastPodcast?.let { app.podcastStore.setProgress(it, com.local.hive.mobile.stream.PodcastStore.FINISHED) }
            }
            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) memory.saveQueue(player)
            }
            override fun onEvents(player: Player, events: Player.Events) {
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_MEDIA_METADATA_CHANGED)) refreshWidget(player)
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_POSITION_DISCONTINUITY,
                        Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED)) memory.saveCursor(player)
            }
        })
        scope.launch {
            while (isActive) {
                delay(5_000)
                if (player.isPlaying) { memory.saveCursor(player); lastPodcast?.let { savePodcast(player, it) } }
            }
        }
        // The curve follows the settings, and for "Auto-Select by Genre" the playing song's genre.
        scope.launch {
            combine(app.equaliser.state, genre) { eq, g -> if (eq.enabled) eq.curve(g) else null }.collect { equaliser.setCurve(it) }
        }
        scope.launch {
            combine(app.equaliser.state, replayGainTags, queueTick) { eq, tags, _ ->
                val mode = if (eq.replayGain == "smart") (if (ReplayGain.smartUsesAlbum(player)) "album" else "track") else eq.replayGain
                ReplayGain.linear(tags, mode, eq.clippingGuard)
            }.distinctUntilChanged().collect { gain ->
                android.util.Log.i("HiveSound", "ReplayGain ${app.equaliser.state.value.replayGain}: x%.3f".format(gain))
                equaliser.setSongGain(gain)
            }
        }
        // Pick up where the last session left off, paused, unless something was queued meanwhile.
        scope.launch {
            val saved = withContext(Dispatchers.IO) { memory.restore() } ?: return@launch
            if (player.mediaItemCount > 0) return@launch
            player.setMediaItems(saved.items, saved.index, saved.positionMs)
            player.shuffleModeEnabled = saved.shuffle
            player.repeatMode = saved.repeatMode
            player.prepare()
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYER, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        libraryBrowser = LibraryBrowser(app.database.dao())
        fun <T> future(block: suspend () -> T): ListenableFuture<T> = SettableFuture.create<T>().also { f ->
            scope.launch { runCatching { withContext(Dispatchers.IO) { block() } }.fold({ f.set(it) }, { f.setException(it) }) }
        }
        session = MediaLibrarySession.Builder(this, player, object : MediaLibrarySession.Callback {
            // Bluetooth play or the system's media controls after a reboot resume the saved queue.
            override fun onPlaybackResumption(mediaSession: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaItemsWithStartPosition> =
                future { memory.restore()?.let { MediaItemsWithStartPosition(it.items, it.index, it.positionMs) } ?: throw UnsupportedOperationException("Nothing to resume") }

            // Android Auto and other browsers: Hive's library as a tree.
            override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
                com.google.common.util.concurrent.Futures.immediateFuture(LibraryResult.ofItem(this@PlaybackService.libraryBrowser.root(), params))

            override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<com.google.common.collect.ImmutableList<MediaItem>>> =
                future {
                    val all = this@PlaybackService.libraryBrowser.children(parentId)
                    LibraryResult.ofItemList(all.drop(page * pageSize).take(pageSize), params)
                }

            override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
                future {
                    val item = this@PlaybackService.libraryBrowser.resolve(listOf(MediaItem.Builder().setMediaId(mediaId).build())).first.firstOrNull()
                    if (item != null) LibraryResult.ofItem(item, null) else LibraryResult.ofError(androidx.media3.session.SessionError.ERROR_BAD_VALUE)
                }

            override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
                scope.launch {
                    val found = withContext(Dispatchers.IO) { this@PlaybackService.libraryBrowser.search(query) }
                    lastSearch = found
                    session.notifySearchResultChanged(browser, query, found.size, params)
                }
                return com.google.common.util.concurrent.Futures.immediateFuture(LibraryResult.ofVoid())
            }

            override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<com.google.common.collect.ImmutableList<MediaItem>>> =
                future { LibraryResult.ofItemList((lastSearch.ifEmpty { this@PlaybackService.libraryBrowser.search(query) }).drop(page * pageSize).take(pageSize), params) }

            // A song picked in a browser plays its list from there; items from Hive itself pass straight through.
            override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
                if (mediaItems.all { it.localConfiguration != null }) com.google.common.util.concurrent.Futures.immediateFuture(mediaItems)
                else future { this@PlaybackService.libraryBrowser.resolve(mediaItems).first.toMutableList() }

            override fun onSetMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaItemsWithStartPosition> =
                if (mediaItems.all { it.localConfiguration != null }) com.google.common.util.concurrent.Futures.immediateFuture(MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs))
                else future {
                    val (queue, start) = this@PlaybackService.libraryBrowser.resolve(mediaItems)
                    MediaItemsWithStartPosition(queue, if (mediaItems.size == 1) start else startIndex.coerceIn(0, (queue.size - 1).coerceAtLeast(0)), startPositionMs)
                }
        }).setSessionActivity(open).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    private lateinit var libraryBrowser: LibraryBrowser
    private var lastSearch: List<MediaItem> = emptyList()

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        session?.player?.let { memory.saveCursor(it) }
        scope.cancel()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}

/**
 * Counts a play once a song has been listened to for half its length or four
 * minutes, whichever comes first (the Last.fm rule Hive's scrobbler uses).
 * Library songs are counted for History and Top 25; songs (library or
 * streamed, not radio or podcasts) are scrobbled.
 */
private class PlayCounter(
    private val recorder: PlayRecorder,
    private val scrobbler: com.local.hive.mobile.stream.Scrobbler,
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val player: Player,
) : Player.Listener {
    private var currentKey: String? = null
    private var listen: com.local.hive.mobile.stream.Listen? = null
    private var listenedMs = 0L
    private var resumedAt = 0L
    private var counted = false
    private var durationMs = 0L

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
            resumedAt = System.currentTimeMillis()
            player.duration.takeIf { it > 0 }?.let { durationMs = it }
        } else accumulate()
        check()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        // Gapless transitions never pause, so the length is taken once loaded.
        if (playbackState == Player.STATE_READY) player.duration.takeIf { it > 0 }?.let { durationMs = it }
    }

    override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
        accumulate()
        check()
        currentKey = mediaItem?.mediaId
        val m = mediaItem?.mediaMetadata
        val key = currentKey
        // Radio and podcast episodes aren't songs to scrobble.
        listen = if (key == null || key.startsWith("radio:") || key.startsWith("pod:") || m?.title.isNullOrBlank() || m?.artist.isNullOrBlank()) null else com.local.hive.mobile.stream.Listen(
            title = m!!.title.toString(), artist = m.artist.toString(), album = m.albumTitle?.toString().orEmpty(),
            durationMs = m.durationMs ?: 0, startedAt = System.currentTimeMillis(),
            service = when { key.startsWith("am:") -> "music.apple.com"; key.startsWith("sp:") -> "spotify.com"; else -> "" },
        )
        listen?.let { l -> scope.launch { scrobbler.nowPlaying(l) } }
        listenedMs = 0
        durationMs = 0
        counted = false
        resumedAt = if (player.isPlaying) System.currentTimeMillis() else 0
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        accumulate()
        check()
        if (player.isPlaying) resumedAt = System.currentTimeMillis()
    }

    private fun accumulate() {
        if (resumedAt > 0) listenedMs += System.currentTimeMillis() - resumedAt
        resumedAt = 0
    }

    private fun check() {
        val key = currentKey ?: return
        if (counted) return
        val duration = durationMs.takeIf { it > 0 } ?: return
        if (listenedMs >= minOf(duration / 2, 4 * 60_000L)) {
            counted = true
            key.toLongOrNull()?.let { recorder.record(it, listenedMs) }
            // Previews (30 s) are not real listens.
            listen?.takeIf { duration > 45_000 }?.let { l -> scope.launch { scrobbler.scrobble(l.copy(durationMs = l.durationMs.takeIf { it > 0 } ?: duration)) } }
        }
    }
}

fun interface PlayRecorder {
    fun record(trackId: Long, listenedMs: Long)
}
