package com.local.hive.mobile.playback

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
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
    private var screenOff: android.content.BroadcastReceiver? = null
    private val replayGainTags = MutableStateFlow<Map<String, String>>(emptyMap())
    private val queueTick = MutableStateFlow(0)
    /** When music last played or stopped playing; paused this long ago or less, the lock player still shows. */
    private var lastPlayingAt = 0L
    /** Set as a controller replaces the queue, so the new queue's shuffle starts from its first song. */
    private var newQueue = false

    private fun shuffleFromCurrent(player: ExoPlayer) {
        val count = player.mediaItemCount
        if (count < 2) return
        val current = player.currentMediaItemIndex
        val order = intArrayOf(current) + (0 until count).filter { it != current }.shuffled().toIntArray()
        player.setShuffleOrder(androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder(order, System.nanoTime()))
    }
    /** Songs put to play next, in the order picked, still to come. */
    private val upNext = ArrayList<String>()

    /**
     * [count] songs, the first of them [first], were just added at the end of the queue to play
     * next: they go after the playing song and any songs put to play next before them, and the
     * queue (or its shuffle) carries on after them as it was.
     */
    private fun placeNext(player: ExoPlayer, count: Int, first: String, tries: Int = 0) {
        val total = player.mediaItemCount
        val start = total - count
        if (count <= 0 || start < 0) return
        // The songs may still be on their way into the queue.
        if (player.getMediaItemAt(start).mediaId != first) {
            if (tries < 20) android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ placeNext(player, count, first, tries + 1) }, 50)
            return
        }
        val ids = (start until total).map { player.getMediaItemAt(it).mediaId }
        val current = player.currentMediaItemIndex
        val shuffled = player.shuffleModeEnabled
        val tl = player.currentTimeline
        val order = if (!shuffled) (0 until total).toList() else
            generateSequence(tl.getFirstWindowIndex(true).takeIf { it != C.INDEX_UNSET }) { tl.getNextWindowIndex(it, Player.REPEAT_MODE_OFF, true).takeIf { i -> i != C.INDEX_UNSET } }.toList()
        val added = (start until total).toList()
        val run = UpNext.run(order.filter { it !in added }, current, { player.getMediaItemAt(it).mediaId }, upNext)
        while (upNext.size > run) upNext.removeAt(upNext.lastIndex)
        if (!shuffled) {
            val at = (current + 1 + run).coerceAtMost(start)
            if (at < start) player.moveMediaItems(start, total, at)
        } else {
            player.setShuffleOrder(androidx.media3.exoplayer.source.ShuffleOrder.DefaultShuffleOrder(UpNext.place(order, current, added, run).toIntArray(), System.nanoTime()))
        }
        upNext += ids
    }

    private fun wantsLockPlayer(player: Player) =
        player.mediaItemCount > 0 && (player.isPlaying || System.currentTimeMillis() - lastPlayingAt < LOCK_PLAYER_AFTER_PAUSE_MS)

    override fun onCreate() {
        super.onCreate()
        // The playing song's notification, on Hive's own channel (made in HiveApp, with no icon badge).
        setMediaNotificationProvider(androidx.media3.session.DefaultMediaNotificationProvider.Builder(this).setChannelId(PLAYBACK_CHANNEL).setChannelName(com.local.hive.mobile.R.string.app_name).build())
        val app = application as HiveApp
        // Streams from Hive on the PC carry the pairing token; nothing else does.
        val dataSources = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, DefaultHttpDataSource.Factory().setUserAgent("HiveMobile"))) { spec ->
            // A song from YouTube Music is looked up as it opens (this runs on the loading thread).
            com.local.hive.mobile.stream.YouTubeMusic.wantedFrom(spec.uri)?.let { song ->
                val url = app.youTubeMusic.resolve(song)
                // YouTube slows down requests without a range, so one is always given.
                val end = if (spec.length != C.LENGTH_UNSET.toLong()) "${spec.position + spec.length - 1}" else ""
                return@Factory spec.withUri(android.net.Uri.parse(url)).withAdditionalHeaders(mapOf("Range" to "bytes=${spec.position}-$end"))
            }
            val pairing = app.linkStore.pairing
            val toPc = pairing != null && spec.uri.scheme == "http" && spec.uri.port == pairing.port && spec.uri.host in pairing.hosts
            // The read-only media key when Hive gave one (songs and covers only), so the real token never
            // travels unencrypted; an older Hive takes the token.
            val mediaKey = app.linkStore.coverKey?.takeIf { it.isNotBlank() }
            if (!toPc) spec
            else if (mediaKey != null) spec.withAdditionalHeaders(mapOf("X-Hive-Media" to mediaKey))
            else spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer ${pairing!!.token}"))
        }
        // Hive's equaliser runs inside the audio sink, ahead of every output.
        fun renderers(processor: EqualiserProcessor) = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf<AudioProcessor>(processor)).build()
        }
        val musicAttributes = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()
        // Plays once a second is buffered (not ExoPlayer's 2.5): streamed songs start sooner, files are instant anyway.
        fun quickStart() = androidx.media3.exoplayer.DefaultLoadControl.Builder()
            .setBufferDurationsMs(15_000, 50_000, 1_000, 2_000).build()
        val player = ExoPlayer.Builder(this, renderers(equaliser))
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources, HiveExtractorsFactory()))
            .setLoadControl(quickStart())
            .setAudioAttributes(musicAttributes, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        // The crossfade's second player takes every other song, under the main player's audio focus.
        crossfader = Crossfader(scope, player, equaliser, app.equaliser.state, newCompanion = { processor ->
            ExoPlayer.Builder(this, renderers(processor))
                .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources, HiveExtractorsFactory()))
                .setLoadControl(quickStart())
                .setAudioAttributes(musicAttributes, /* handleAudioFocus = */ false)
                .build()
        }, stopsAtSongEnd = { app.stopsAtSongEnd }, songGain = { tracks ->
            val eq = app.equaliser.state.value
            val mode = if (eq.replayGain == "smart") (if (ReplayGain.smartUsesAlbum(player)) "album" else "track") else eq.replayGain
            ReplayGain.linear(ReplayGain.tagsOf(tracks), mode, eq.clippingGuard)
        })
        // The queue's name in the car's and other controllers' queue view.
        player.playlistMetadata = androidx.media3.common.MediaMetadata.Builder().setTitle("Up next").build()
        player.addListener(PlayCounter(app.playRecorder, app.scrobbler, scope, player))
        player.addListener(object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS) reclaimForDrive()
                // The user paused or picked something themselves: the drive's start is over.
                else if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST) driveStartedAt = 0L
            }
        })
        // The songs the player has open (this one, and the ones either side a skip or crossfade opens):
        // their files aren't rewritten to keep Love in them until they're closed (see LoveFiles).
        player.addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                if (!events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED)) return
                val i = player.currentMediaItemIndex
                OpenSongs.ids = (i - 1..i + 2).filter { it in 0 until player.mediaItemCount }
                    .mapNotNull { player.getMediaItemAt(it).mediaId.substringAfterLast('|').toLongOrNull() }.toSet()
            }
        })
        // A shuffle starts from the song playing and plays every other song once after it. ExoPlayer's
        // own order put the starting song anywhere, so the songs ahead of it in the order never played.
        player.addListener(object : Player.Listener {
            override fun onShuffleModeEnabledChanged(enabled: Boolean) { upNext.clear(); if (enabled) shuffleFromCurrent(player) }
            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED && newQueue) { newQueue = false; upNext.clear(); if (player.shuffleModeEnabled) shuffleFromCurrent(player) }
            }
            // A song put to play next has come up: the next one picked goes after those still to come.
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                if (upNext.firstOrNull() == mediaItem?.mediaId) upNext.removeAt(0) else if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) upNext.clear()
            }
        })
        // Auto DJ for streamed songs: when an Apple Music or Spotify song is the last in the queue,
        // similar songs (YouTube Music's radio from it) are added after it, so the music carries on.
        player.addListener(object : Player.Listener {
            private var seeded: String? = null
            override fun onEvents(player: Player, events: Player.Events) {
                if (!events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED)) return
                if (player.repeatMode != Player.REPEAT_MODE_OFF || player.hasNextMediaItem()) return
                val item = player.currentMediaItem ?: return
                val song = item.localConfiguration?.uri?.let { com.local.hive.mobile.stream.YouTubeMusic.wantedFrom(it) }
                if (song == null) { android.util.Log.i("Hive", "Auto DJ: last song isn't streamed (${item.localConfiguration?.uri?.scheme})"); return }
                if (seeded == item.mediaId) return
                seeded = item.mediaId
                scope.launch(Dispatchers.IO) {
                    val tracks = runCatching { app.youTubeMusic.radio(song) }.onFailure { android.util.Log.w("Hive", "Auto DJ: ${it.message}") }.getOrNull().orEmpty()
                    android.util.Log.i("Hive", "Auto DJ: ${tracks.size} songs like ${song.title}")
                    if (tracks.isEmpty()) return@launch
                    runCatching { app.database.dao().upsertStreamTracks(tracks) }
                    val items = tracks.map { t -> t.toMediaItem(com.local.hive.mobile.stream.YouTubeMusic.uriFor(com.local.hive.mobile.stream.WantedSong(t.key, t.title, t.artist, t.album, t.durationMs))) }
                    kotlinx.coroutines.withContext(Dispatchers.Main) {
                        // Only if the queue still ends at that song (nothing was picked meanwhile).
                        if (player.currentMediaItem?.mediaId != item.mediaId || player.hasNextMediaItem()) { seeded = null; return@withContext }
                        val inQueue = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }.toSet()
                        player.addMediaItems(items.filter { it.mediaId !in inQueue })
                        seeded = null // done: the same song picked again later grows its own queue
                        // A song that had already ended (or failed) with nothing after it: carry on now.
                        if (player.playbackState == Player.STATE_ENDED || player.playerError != null) { player.seekToNextMediaItem(); player.prepare(); player.play() }
                    }
                }
            }
        })
        // The next 20 streamed songs are found on YouTube Music while this one plays, so they start at once:
        // one at a time with a pause between (YouTube never sees a burst), started over when the queue moves.
        player.addListener(object : Player.Listener {
            private var preparing: kotlinx.coroutines.Job? = null
            override fun onEvents(player: Player, events: Player.Events) {
                if (!events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED)) return
                // What actually plays next, shuffle and repeat included.
                val tl = player.currentTimeline
                val next = if (tl.isEmpty) emptyList() else generateSequence(player.currentMediaItemIndex) { i ->
                    tl.getNextWindowIndex(i, player.repeatMode.takeIf { it != androidx.media3.common.Player.REPEAT_MODE_ONE } ?: androidx.media3.common.Player.REPEAT_MODE_OFF, player.shuffleModeEnabled).takeIf { it != androidx.media3.common.C.INDEX_UNSET }
                }.drop(1).take(20).filter { it != player.currentMediaItemIndex }.toList()
                    .mapNotNull { player.getMediaItemAt(it).localConfiguration?.uri }
                    .mapNotNull { com.local.hive.mobile.stream.YouTubeMusic.wantedFrom(it) }
                preparing?.cancel()
                if (next.isNotEmpty()) preparing = scope.launch(Dispatchers.IO) {
                    next.forEachIndexed { i, song -> runCatching { app.youTubeMusic.resolve(song) }; if (i >= 1) kotlinx.coroutines.delay(600) }
                }
            }
        })
        // Hive's lock-screen player covers the lock screen whenever Hive is in use: opened as the
        // screen goes off (so it's there when it comes on), again as it comes on locked (in case
        // something closed it), and when music starts on a locked phone (from the car, or the
        // phone's own lock-screen controls). Paused, it stays for a while, as Samsung Music's does.
        screenOff = object : android.content.BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val locked = (getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked
                com.local.hive.mobile.LockPlayerActivity.screenChanged()
                if (intent.action == Intent.ACTION_SCREEN_ON && !locked) return
                if (wantsLockPlayer(player)) com.local.hive.mobile.LockPlayerActivity.showIfWanted(this@PlaybackService)
            }
        }
        androidx.core.content.ContextCompat.registerReceiver(this, screenOff, android.content.IntentFilter(Intent.ACTION_SCREEN_OFF).apply { addAction(Intent.ACTION_SCREEN_ON) }, androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED)
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                lastPlayingAt = System.currentTimeMillis()
                val locked = (getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked
                if (isPlaying && locked) com.local.hive.mobile.LockPlayerActivity.showIfWanted(this@PlaybackService)
            }
        })
        // Listens that couldn't be sent last time go now.
        scope.launch(Dispatchers.IO) { app.scrobbler.scrobble(null) }
        memory = PlaybackMemory(
            this, app.database.dao(),
            // A restored Apple Music or Spotify song plays in full again, not as its preview.
            streamUri = { s ->
                if (app.youTubeMusic.enabled.value) com.local.hive.mobile.stream.YouTubeMusic.uriFor(com.local.hive.mobile.stream.WantedSong(s.key, s.title, s.artist, s.album, s.durationMs))
                else null
            },
        ) { ids -> app.pcLibrary.mediaItems(ids) }
        player.addListener(object : Player.Listener {
            private var retried: String? = null

            // A full song that fails tries again: through the PC, then YouTube Music
            // directly (once with a fresh link). Never a 30-second preview: a song that still
            // won't play is skipped.
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                val item = player.currentMediaItem ?: return
                val uri = item.localConfiguration?.uri ?: return
                val position = player.currentPosition
                fun retry(next: android.net.Uri, from: Long = position) {
                    player.replaceMediaItem(player.currentMediaItemIndex, item.buildUpon().setUri(next).build())
                    player.seekTo(player.currentMediaItemIndex, from)
                    player.prepare()
                    player.play()
                }
                val ytm = com.local.hive.mobile.stream.YouTubeMusic.wantedFrom(uri)
                if (ytm != null && retried != item.mediaId) {
                    retried = item.mediaId
                    app.youTubeMusic.invalidate(ytm.key)
                    return retry(uri)
                }
                val fromPc = app.sync.streams.value?.isFor(uri) == true || uri.path == "/api/stream/song"
                if (fromPc && app.youTubeMusic.enabled.value) {
                    val m = item.mediaMetadata
                    val song = com.local.hive.mobile.stream.WantedSong(item.mediaId, m.title?.toString().orEmpty(), m.artist?.toString().orEmpty(), m.albumTitle?.toString().orEmpty(), m.durationMs ?: 0)
                    return retry(android.net.Uri.parse(com.local.hive.mobile.stream.YouTubeMusic.uriFor(song)))
                }
                if (ytm != null && player.hasNextMediaItem()) { player.seekToNextMediaItem(); player.prepare(); player.play() }
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
        libraryBrowser = LibraryBrowser(this, app.database.dao())
        fun <T> future(block: suspend () -> T): ListenableFuture<T> = SettableFuture.create<T>().also { f ->
            scope.launch { runCatching { withContext(Dispatchers.IO) { block() } }.fold({ f.set(it) }, { f.setException(it) }) }
        }
        // Skipping forward goes through the crossfade when "Crossfade when skipping" is on.
        val sessionPlayer = object : androidx.media3.common.ForwardingPlayer(player) {
            override fun seekToNext() { if (!crossfader.skip()) super.seekToNext() }
            override fun seekToNextMediaItem() { if (!crossfader.skip()) super.seekToNextMediaItem() }
            // Play from the car, a headset or the lock screen always starts the music: after an error it
            // prepares again, and when another app (the assistant, a call) took the sound, it asks for it back.
            override fun play() {
                if (playbackState == Player.STATE_IDLE) super.prepare()
                if (playWhenReady && !isPlaying) super.pause()
                super.play()
            }
        }
        session = MediaLibrarySession.Builder(this, sessionPlayer, object : MediaLibrarySession.Callback {
            // Every controller (the car, the lock screen, Bluetooth) may use Hive's heart, shuffle and repeat buttons.
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
                MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .also {
                        CarLog.note(this@PlaybackService, controller.packageName, "connect (controller version ${controller.controllerVersion}, trusted ${controller.isTrusted})")
                        val wasInCar = CarLog.carConnected
                        CarLog.car(this@PlaybackService, controller.packageName, connected = true)
                        if (controller.packageName == CarLog.ANDROID_AUTO && !wasInCar) startForDrive()
                    }
                    .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(CMD_LOVE).add(CMD_SHUFFLE).add(CMD_REPEAT).add(CMD_SKIP).add(HIVE_PLAY_NEXT).build())
                    .build()

            override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) =
                CarLog.car(this@PlaybackService, controller.packageName, connected = false)

            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: androidx.media3.session.SessionCommand, args: android.os.Bundle): ListenableFuture<androidx.media3.session.SessionResult> {
                when (customCommand.customAction) {
                    CMD_LOVE.customAction -> toggleLove(player)
                    // Hive's own skip button: what the player does is reported back, instead of the app
                    // guessing the next song at once (it showed for a moment, then the crossfade's song).
                    CMD_SKIP.customAction -> if (!crossfader.skip()) player.seekToNext()
                    CMD_SHUFFLE.customAction -> player.shuffleModeEnabled = !player.shuffleModeEnabled
                    HIVE_PLAY_NEXT.customAction -> placeNext(player, args.getInt("count"), args.getString("first").orEmpty())
                    CMD_REPEAT.customAction -> player.repeatMode = when (player.repeatMode) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }
                }
                return com.google.common.util.concurrent.Futures.immediateFuture(androidx.media3.session.SessionResult(androidx.media3.session.SessionResult.RESULT_SUCCESS))
            }

            // Play from the car, headphones or a Bluetooth button while a radio station sits paused: Hive's
            // music comes back (the saved queue), so a station never starts in place of it on plugging in.
            override fun onMediaButtonEvent(session: MediaSession, controllerInfo: MediaSession.ControllerInfo, intent: Intent): Boolean {
                @Suppress("DEPRECATION")
                val key = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, android.view.KeyEvent::class.java) else intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT))
                val play = key?.action == android.view.KeyEvent.ACTION_DOWN && key.keyCode in listOf(android.view.KeyEvent.KEYCODE_MEDIA_PLAY, android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, android.view.KeyEvent.KEYCODE_HEADSETHOOK)
                val station = player.currentMediaItem?.mediaId?.let(PlaybackMemory::notMusic) == true
                if (play && station && !player.isPlaying) {
                    CarLog.note(this@PlaybackService, controllerInfo.packageName, "play with a station paused: music instead")
                    scope.launch {
                        val music = memory.restore()
                        if (music != null) player.setMediaItems(music.items, music.index, music.positionMs)
                        player.prepare(); player.play()
                    }
                    return true
                }
                return super.onMediaButtonEvent(session, controllerInfo, intent)
            }

            // Bluetooth play or the system's media controls after a reboot resume the saved queue.
            override fun onPlaybackResumption(mediaSession: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaItemsWithStartPosition> =
                future {
                    CarLog.note(this@PlaybackService, controller.packageName, "resume playback")
                    memory.restore()?.let { MediaItemsWithStartPosition(it.items, it.index, it.positionMs) } ?: throw UnsupportedOperationException("Nothing to resume") }

            // Android Auto and other browsers: Hive's library as a tree.
            override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
                CarLog.note(this@PlaybackService, browser.packageName, "library root (recent ${params?.isRecent}, offline ${params?.isOffline})")
                // The car lays folders out as grids of covers and songs as lists unless a folder says otherwise.
                return com.google.common.util.concurrent.Futures.immediateFuture(LibraryResult.ofItem(this@PlaybackService.libraryBrowser.root(), LibraryParams.Builder().setExtras(this@PlaybackService.libraryBrowser.rootExtras()).build()))
            }

            override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<com.google.common.collect.ImmutableList<MediaItem>>> =
                future {
                    val shown = runCatching { this@PlaybackService.libraryBrowser.children(parentId).drop(page * pageSize).take(pageSize) }
                        .onFailure { CarLog.note(this@PlaybackService, browser.packageName, "children of $parentId failed: $it") }.getOrThrow()
                    CarLog.note(this@PlaybackService, browser.packageName, "children of $parentId page $page: ${shown.size}")
                    CoverProvider.grant(this@PlaybackService, browser.packageName, shown)
                    LibraryResult.ofItemList(shown, params)
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
                future {
                    val shown = (lastSearch.ifEmpty { this@PlaybackService.libraryBrowser.search(query) }).drop(page * pageSize).take(pageSize)
                    CoverProvider.grant(this@PlaybackService, browser.packageName, shown)
                    LibraryResult.ofItemList(shown, params)
                }

            // A song picked in a browser plays its list from there; items from Hive itself pass straight through.
            override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
                if (mediaItems.all { it.localConfiguration != null }) com.google.common.util.concurrent.Futures.immediateFuture(mediaItems)
                else future { this@PlaybackService.libraryBrowser.resolve(mediaItems).first.toMutableList() }

            override fun onSetMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaItemsWithStartPosition> {
                newQueue = true
                return if (mediaItems.all { it.localConfiguration != null }) com.google.common.util.concurrent.Futures.immediateFuture(MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs))
                else future {
                    val (queue, start) = this@PlaybackService.libraryBrowser.resolve(mediaItems)
                    MediaItemsWithStartPosition(queue, if (mediaItems.size == 1) start else startIndex.coerceIn(0, (queue.size - 1).coerceAtLeast(0)), startPositionMs)
                }
            }
        }).setSessionActivity(open)
            .setBitmapLoader(androidx.media3.session.CacheBitmapLoader(CoverBitmapLoader(this, scope)))
            .build()
        // A crossfade under way reaches Hive's screens, which keep showing the song fading out until it's done.
        scope.launch { crossfader.handover.collect { h -> session?.setSessionExtras(h?.toBundle() ?: android.os.Bundle.EMPTY) } }
        // The buttons follow the song, its heart, shuffle and repeat.
        scope.launch { app.database.dao().loveStates().collect { list -> lovedIds.value = list.filter { it.loved }.mapTo(HashSet()) { it.trackId }; refreshButtons(player) } }
        scope.launch { app.streamLoves.loves.collect { refreshButtons(player) } }
        scope.launch { app.pcLibrary.lovedIds.collect { refreshButtons(player) } }
        player.addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED)) refreshButtons(player)
            }
        })
        refreshButtons(player)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? {
        CarLog.note(this, controllerInfo.packageName, "asks for the session (${if (session == null) "none yet" else "ready"})")
        return session
    }

    private companion object {
        val CMD_LOVE = androidx.media3.session.SessionCommand("hive.love", android.os.Bundle.EMPTY)
        const val LOCK_PLAYER_AFTER_PAUSE_MS = 30 * 60_000L
        val CMD_SHUFFLE = androidx.media3.session.SessionCommand("hive.shuffle", android.os.Bundle.EMPTY)
        val CMD_REPEAT = androidx.media3.session.SessionCommand("hive.repeat", android.os.Bundle.EMPTY)
        val CMD_SKIP = HIVE_SKIP
    }

    private lateinit var libraryBrowser: LibraryBrowser
    private val lovedIds = MutableStateFlow<Set<Long>>(emptySet())

    /**
     * The heart, shuffle and repeat buttons beside the transport controls in
     * the car, on the system lock screen and in the notification's overflow,
     * showing the current state.
     */
    private val hive get() = application as HiveApp

    /** The current song's heart (see heartFor): null when it takes none. */
    private fun heart(player: Player): Boolean? {
        val item = player.currentMediaItem ?: return null
        if (item.mediaId.startsWith(com.local.hive.mobile.link.PcLibrary.MEDIA_PREFIX)) scope.launch { hive.pcLibrary.load() }
        return com.local.hive.mobile.link.heartFor(item.mediaId, item.mediaMetadata.title?.toString().orEmpty(), item.mediaMetadata.artist?.toString().orEmpty(),
            lovedIds.value, hive.streamLoves.loves.value, hive.pcLibrary.lovedIds.value)
    }

    private fun toggleLove(player: Player) {
        val item = player.currentMediaItem ?: return
        val loved = heart(player) ?: return
        val id = item.mediaId.substringAfterLast('|').toLongOrNull()
        if (id != null) scope.launch { hive.sync.setLoved(listOf(id), !loved) }
        else item.mediaMetadata.let { m ->
            hive.sync.setStreamLoved(m.title?.toString().orEmpty(), m.artist?.toString().orEmpty(), m.albumTitle?.toString().orEmpty(),
                player.duration.coerceAtLeast(0), m.artworkUri?.toString().orEmpty(), item.mediaId, !loved)
        }
    }

    private fun refreshButtons(player: Player) {
        val session = session ?: return
        val loved = heart(player)
        fun button(icon: Int, name: String, command: androidx.media3.session.SessionCommand) =
            androidx.media3.session.CommandButton.Builder(icon).setDisplayName(name).setSessionCommand(command).setSlots(androidx.media3.session.CommandButton.SLOT_OVERFLOW).build()
        val buttons = listOfNotNull(
            loved?.let { if (it) button(androidx.media3.session.CommandButton.ICON_HEART_FILLED, "Remove from Favorites", CMD_LOVE) else button(androidx.media3.session.CommandButton.ICON_HEART_UNFILLED, "Add to Favorites", CMD_LOVE) },
            if (player.shuffleModeEnabled) button(androidx.media3.session.CommandButton.ICON_SHUFFLE_ON, "Shuffle on", CMD_SHUFFLE) else button(androidx.media3.session.CommandButton.ICON_SHUFFLE_OFF, "Shuffle off", CMD_SHUFFLE),
            when (player.repeatMode) {
                Player.REPEAT_MODE_ONE -> button(androidx.media3.session.CommandButton.ICON_REPEAT_ONE, "Repeat one", CMD_REPEAT)
                Player.REPEAT_MODE_ALL -> button(androidx.media3.session.CommandButton.ICON_REPEAT_ALL, "Repeat all", CMD_REPEAT)
                else -> button(androidx.media3.session.CommandButton.ICON_REPEAT_OFF, "Repeat off", CMD_REPEAT)
            },
        )
        session.setMediaButtonPreferences(buttons)
    }
    private lateinit var crossfader: Crossfader
    private var lastSearch: List<MediaItem> = emptyList()

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
    }

    /** When this drive's music started on its own (0: not in a drive's first moments). */
    private var driveStartedAt = 0L
    private var driveReclaimed = false

    private fun onACall() = getSystemService(android.media.AudioManager::class.java)?.mode in
        listOf(android.media.AudioManager.MODE_IN_CALL, android.media.AudioManager.MODE_IN_COMMUNICATION, android.media.AudioManager.MODE_RINGTONE)

    /**
     * The phone joined the car (Android Auto came, after a while away): Hive's music starts, from
     * where it was, unless Hive is already playing or a call is on. Hive takes the sound, so
     * whatever Android Auto or the Assistant started meanwhile (a news briefing) stops. A reconnect
     * a few minutes into the same drive (a loose cable) is left alone.
     */
    private fun startForDrive() {
        val away = CarLog.disconnectedAt
        if (away > 0 && System.currentTimeMillis() - away < DRIVE_GAP_MS) return
        scope.launch {
            val player = session?.player ?: return@launch
            // Android Auto starts its own things first (it resumes its last app); Hive comes after.
            delay(2_500)
            if (player.isPlaying || onACall()) return@launch
            val station = player.currentMediaItem?.mediaId?.let(PlaybackMemory::notMusic) == true
            if (player.mediaItemCount == 0 || station) {
                val music = withContext(Dispatchers.IO) { memory.restore() } ?: return@launch
                player.setMediaItems(music.items, music.index, music.positionMs)
                player.shuffleModeEnabled = music.shuffle
                player.repeatMode = music.repeatMode
            }
            CarLog.note(this@PlaybackService, CarLog.ANDROID_AUTO, "drive starts: Hive plays")
            driveStartedAt = System.currentTimeMillis(); driveReclaimed = false
            player.prepare(); player.play()
        }
    }

    /**
     * Something took the sound away from Hive just as the drive began (a news briefing starting a
     * moment late): Hive takes it back, once. Later, or a second time, what the user picked wins.
     */
    private fun reclaimForDrive() {
        if (driveStartedAt == 0L || driveReclaimed || System.currentTimeMillis() - driveStartedAt > RECLAIM_MS) return
        driveReclaimed = true
        scope.launch {
            val player = session?.player ?: return@launch
            delay(1_500)
            if (player.isPlaying || onACall() || !CarLog.carConnected) return@launch
            CarLog.note(this@PlaybackService, CarLog.ANDROID_AUTO, "sound taken at the drive's start: Hive plays again")
            player.play()
        }
    }

    override fun onDestroy() {
        OpenSongs.ids = emptySet()
        screenOff?.let { runCatching { unregisterReceiver(it) } }
        session?.player?.let { memory.saveCursor(it) }
        if (::crossfader.isInitialized) crossfader.close()
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
    // History takes a song after a few seconds of listening, much sooner than a counted play.
    private var currentItem: androidx.media3.common.MediaItem? = null
    private var historyDone = false
    private var historyJob: kotlinx.coroutines.Job? = null

    private fun armHistory() {
        historyJob?.cancel()
        val item = currentItem ?: return
        if (historyDone || !player.isPlaying) return
        val heard = listenedMs + if (resumedAt > 0) System.currentTimeMillis() - resumedAt else 0
        historyJob = scope.launch {
            kotlinx.coroutines.delay((HISTORY_MS - heard).coerceAtLeast(0))
            if (currentItem === item && player.isPlaying && !historyDone) { historyDone = true; recorder.history(item) }
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
            resumedAt = System.currentTimeMillis()
            player.duration.takeIf { it > 0 }?.let { durationMs = it }
        } else accumulate()
        check()
        armHistory()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_READY) takeLength()
    }

    // A song that follows straight on (gapless) never pauses or reloads, so its length is taken
    // as soon as the player knows it, or the play would never count.
    override fun onTracksChanged(tracks: androidx.media3.common.Tracks) = takeLength()
    override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) = takeLength()

    private fun takeLength() {
        if (player.currentMediaItem?.mediaId != currentItem?.mediaId) return
        player.duration.takeIf { it > 0 }?.let { durationMs = it }
    }

    override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
        accumulate()
        check()
        // Android Auto lists songs as "<list>|<id>": the song is the id.
        currentKey = mediaItem?.mediaId?.substringAfterLast('|')
        currentItem = mediaItem
        historyDone = false
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
        // Its length from the library straight away; the player's own replaces it once known.
        durationMs = mediaItem?.mediaMetadata?.durationMs?.takeIf { it > 0 } ?: 0
        counted = false
        resumedAt = if (player.isPlaying) System.currentTimeMillis() else 0
        takeLength()
        armHistory()
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
            // Library songs by their phone id; songs streamed from Hive on the PC by
            // their id there, so they count in Hive's Wrap too.
            key.toLongOrNull()?.let { recorder.record(it, listenedMs) }
                ?: key.takeIf { it.startsWith("pc:") }?.let { recorder.recordPc(it.removePrefix("pc:"), listenedMs) }
            // Previews (30 s) are not real listens.
            listen?.takeIf { duration > 45_000 }?.let { l -> scope.launch { scrobbler.scrobble(l.copy(durationMs = l.durationMs.takeIf { it > 0 } ?: duration)) } }
        }
    }
}

fun interface PlayRecorder {
    fun record(trackId: Long, listenedMs: Long)
    /** A song streamed from Hive on the PC, by its id there. */
    fun recordPc(pcId: String, listenedMs: Long) {}
    /** A song listened to for [HISTORY_MS]: it goes into Recently played. */
    fun history(item: androidx.media3.common.MediaItem) {}
}

/** How long a song plays before it shows in Recently played. */
const val HISTORY_MS = 5_000L

/** Android Auto back within this long is the same drive (a loose cable), not a new one. */
private const val DRIVE_GAP_MS = 10 * 60_000L
/** How long into a drive Hive takes the sound back from something that started on its own. */
private const val RECLAIM_MS = 60_000L

/** Hive's own skip button (see PlayerConnection.next): the player answers with what it really did. */
val HIVE_SKIP = androidx.media3.session.SessionCommand("hive.skip", android.os.Bundle.EMPTY)

/** Songs just added at the end of the queue to play next (see PlaybackService.placeNext). */
val HIVE_PLAY_NEXT = androidx.media3.session.SessionCommand("hive.playNext", android.os.Bundle.EMPTY)

/** The playing song's notification channel (no icon badge). */
const val PLAYBACK_CHANNEL = "hive-playback"

/** Library songs the player has open now, so their files aren't rewritten under it. */
object OpenSongs { @Volatile var ids: Set<Long> = emptySet() }
