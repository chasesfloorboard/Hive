package com.local.hive.mobile.stream

import org.junit.Assert.assertEquals
import org.junit.Test

class LastFmSignatureTest {
    // Last.fm's documented recipe: sorted name+value pairs, then the secret, md5'd; format is left out.
    @Test fun signatureMatchesTheRecipe() {
        val sig = Scrobbler.signature(mapOf("method" to "auth.getSession", "api_key" to "abc", "token" to "t1", "format" to "json"), "s3cret")
        val expected = java.security.MessageDigest.getInstance("MD5").digest("api_keyabcmethodauth.getSessiontokent1s3cret".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, sig)
    }
}
