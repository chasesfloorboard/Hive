package com.local.hive.mobile.stream

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class AppleAccountTest {
    private fun jwt(claims: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString("""{"typ":"JWT","alg":"ES256"}""".toByteArray()) + "." + enc.encodeToString(claims.toByteArray()) + ".c2lnbmF0dXJl"
    }

    @Test fun findsTheWebPlayersKeyAmongOtherKeysInItsScript() {
        val other = jwt("""{"iss":"5IKPS","exp":1}""")
        val web = jwt("""{"iss":"AMPWebPlay","iat":1792780534,"exp":1798828534,"root_https_origin":["apple.com"]}""")
        val script = """var a="$other";const b={developerToken:"$web",app:1};"""
        assertEquals(web to 1798828534L, AppleAccount.findWebPlayerKey(script))
        assertNull(AppleAccount.findWebPlayerKey("""x="$other""""))
    }

    @Test fun libraryLinksAreKeptApartFromAppleMusicLinks() {
        assertEquals("p.AbC123", AppleAccount.libraryId(AppleAccount.libraryUrl("p.AbC123")))
        assertNull(AppleAccount.libraryId("https://music.apple.com/us/playlist/x/pl.123"))
        assertEquals("https://music.apple.com/library/playlist/p.AbC123", AppleAccount.webUrl("apple-library:p.AbC123"))
        assertEquals("https://music.apple.com/library/songs", AppleAccount.webUrl(AppleAccount.libraryUrl(AppleAccount.SONGS_ID)))
    }
}
