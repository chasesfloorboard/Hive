package com.local.hive.mobile.data

/**
 * Resolves the cover URI for whatever is currently playing.
 *
 * ExoPlayer's queued [androidx.media3.common.MediaItem] keeps a snapshot of the track's
 * `artworkUri` from the moment it was queued. If the track's tags/album were edited, merged by
 * [AlbumMerge], rescanned to a new MediaStore `albumId`, or its album cover was cleared via
 * [AlbumCovers], that snapshot goes stale while the album page displays the live library album.
 *
 * For local library tracks present in Room, derive the URI from the live track (respecting loose
 * collections and hidden covers); for streams, PC library tracks, radio, and podcasts, keep the
 * player item's own URI.
 */
object NowArtworkResolver {
    fun resolve(
        nowArtworkUri: String?,
        trackId: Long?,
        trackAlbum: String?,
        trackAlbumId: Long?,
        hiddenAlbumCovers: Set<Long> = emptySet(),
    ): String? {
        if (trackId != null && trackAlbumId != null) {
            if (AlbumArtFetcher.isLooseCollection(trackAlbum)) {
                return "content://media/external/audio/media/$trackId/albumart"
            }
            if (trackAlbumId in hiddenAlbumCovers) return null
            return "content://media/external/audio/albumart/$trackAlbumId"
        }
        return nowArtworkUri
    }

    fun resolve(
        nowArtworkUri: String?,
        track: Track?,
        hiddenAlbumCovers: Set<Long> = emptySet(),
    ): String? = resolve(
        nowArtworkUri = nowArtworkUri,
        trackId = track?.id,
        trackAlbum = track?.album,
        trackAlbumId = track?.albumId,
        hiddenAlbumCovers = hiddenAlbumCovers,
    )
}
