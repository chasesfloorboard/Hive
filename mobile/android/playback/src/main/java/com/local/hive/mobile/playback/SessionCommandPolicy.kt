package com.local.hive.mobile.playback

import androidx.media3.common.HeartRating
import androidx.media3.common.Rating
import androidx.media3.common.ThumbRating
import androidx.media3.session.MediaSession

/**
 * Authorization and rating mapping rules for [PlaybackService]'s exported [MediaSession].
 *
 * Hive's heart/favorite button is advertised in the session's media button preferences for
 * Android Auto, Android Automotive OS, System UI (lock screen / notification controls), Wear OS,
 * and other trusted system controllers. Media3 requires every controller that invokes a custom
 * command to have that command in its `availableSessionCommands` (returned from `onConnect`),
 * otherwise `MediaSessionLegacyStub` silently drops the tap before `onCustomCommand` even runs.
 *
 * Queue-mutating internal commands (`HIVE_PLAY_NEXT`) stay restricted to Hive's own UI.
 */
object SessionCommandPolicy {
    const val SYSTEM_UI_PACKAGE = "com.android.systemui"

    /**
     * Pure check for whether a controller may see and invoke Hive's favorite (`CMD_LOVE`) and
     * heart/thumb rating commands.
     */
    fun canLove(
        controllerPackage: String,
        ownPackage: String,
        isTrusted: Boolean,
        isMediaNotificationController: Boolean = false,
        isAutoCompanionController: Boolean = false,
        isAutomotiveController: Boolean = false,
    ): Boolean =
        controllerPackage == ownPackage ||
            isMediaNotificationController ||
            isAutoCompanionController ||
            isAutomotiveController ||
            controllerPackage == CarLog.ANDROID_AUTO ||
            controllerPackage == SYSTEM_UI_PACKAGE ||
            isTrusted

    /** MediaSession convenience wrapper around [canLove]. */
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    fun canLove(
        session: MediaSession,
        controller: MediaSession.ControllerInfo,
        ownPackage: String,
    ): Boolean = canLove(
        controllerPackage = controller.packageName,
        ownPackage = ownPackage,
        isTrusted = controller.isTrusted,
        isMediaNotificationController = session.isMediaNotificationController(controller),
        isAutoCompanionController = session.isAutoCompanionController(controller),
        isAutomotiveController = session.isAutomotiveController(controller),
    )

    /** Internal queue-reordering commands (`HIVE_PLAY_NEXT`) are strictly for Hive's own UI. */
    fun canMutateQueue(controllerPackage: String, ownPackage: String): Boolean =
        controllerPackage == ownPackage

    /** Maps a heart or thumb [Rating] to Hive's loved boolean, or null for unsupported rating styles. */
    fun ratingToLoved(rating: Rating): Boolean? = when (rating) {
        is HeartRating -> rating.isRated && rating.isHeart
        is ThumbRating -> rating.isRated && rating.isThumbsUp
        else -> null
    }
}
