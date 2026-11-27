package com.local.hive.mobile.playback

import androidx.media3.common.HeartRating
import androidx.media3.common.PercentageRating
import androidx.media3.common.StarRating
import androidx.media3.common.ThumbRating
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCommandPolicyTest {
    private val own = "com.local.hive.mobile"

    @Test
    fun androidAutoAndAutomotiveControllersCanLoveEvenWithoutTrustedFlag() {
        assertTrue(
            SessionCommandPolicy.canLove(
                controllerPackage = CarLog.ANDROID_AUTO,
                ownPackage = own,
                isTrusted = false,
                isAutoCompanionController = true,
            ),
        )
        assertTrue(
            SessionCommandPolicy.canLove(
                controllerPackage = CarLog.ANDROID_AUTO,
                ownPackage = own,
                isTrusted = false,
            ),
        )
        assertTrue(
            SessionCommandPolicy.canLove(
                controllerPackage = "com.android.car.media",
                ownPackage = own,
                isTrusted = false,
                isAutomotiveController = true,
            ),
        )
    }

    @Test
    fun ownUiNotificationSystemUiAndTrustedControllersCanLove() {
        assertTrue(SessionCommandPolicy.canLove(controllerPackage = own, ownPackage = own, isTrusted = false))
        assertTrue(
            SessionCommandPolicy.canLove(
                controllerPackage = own,
                ownPackage = own,
                isTrusted = false,
                isMediaNotificationController = true,
            ),
        )
        assertTrue(
            SessionCommandPolicy.canLove(
                controllerPackage = SessionCommandPolicy.SYSTEM_UI_PACKAGE,
                ownPackage = own,
                isTrusted = false,
            ),
        )
        // Wear OS, Bluetooth, Google Assistant, or any controller holding MEDIA_CONTENT_CONTROL.
        assertTrue(
            SessionCommandPolicy.canLove(
                controllerPackage = "com.google.android.wearable.app",
                ownPackage = own,
                isTrusted = true,
            ),
        )
    }

    @Test
    fun untrustedThirdPartyControllersCannotLove() {
        assertFalse(
            SessionCommandPolicy.canLove(
                controllerPackage = "com.example.untrusted",
                ownPackage = own,
                isTrusted = false,
            ),
        )
    }

    @Test
    fun queueMutationStaysRestrictedToOwnUiOnly() {
        assertTrue(SessionCommandPolicy.canMutateQueue(own, own))
        assertFalse(SessionCommandPolicy.canMutateQueue(CarLog.ANDROID_AUTO, own))
        assertFalse(SessionCommandPolicy.canMutateQueue(SessionCommandPolicy.SYSTEM_UI_PACKAGE, own))
        assertFalse(SessionCommandPolicy.canMutateQueue("com.example.untrusted", own))
    }

    @Test
    fun ratingToLovedMapsHeartAndThumbRatingsAndIgnoresOthers() {
        assertEquals(true, SessionCommandPolicy.ratingToLoved(HeartRating(true)))
        assertEquals(false, SessionCommandPolicy.ratingToLoved(HeartRating(false)))
        assertEquals(false, SessionCommandPolicy.ratingToLoved(HeartRating()))
        assertEquals(true, SessionCommandPolicy.ratingToLoved(ThumbRating(true)))
        assertEquals(false, SessionCommandPolicy.ratingToLoved(ThumbRating(false)))
        assertEquals(false, SessionCommandPolicy.ratingToLoved(ThumbRating()))
        assertNull(SessionCommandPolicy.ratingToLoved(StarRating(5, 4f)))
        assertNull(SessionCommandPolicy.ratingToLoved(PercentageRating(80f)))
    }
}
