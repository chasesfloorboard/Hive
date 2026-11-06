package com.local.hive.mobile.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class HelloProofTest {
    // The same value hive-link.js /api/hello gives (worked out with Node's crypto for these inputs).
    @Test fun thePhoneChecksTheProofExactlyAsThePcMakesIt() {
        assertEquals("dd120338f27d722a7b5411ed43de328e528403af8419965fd3daca8bab86f694", helloProof("tok-123", "nnnnnnnnnnnnnnnnn", "server-1"))
        assertNotEquals(helloProof("tok-123", "nnnnnnnnnnnnnnnnn", "server-1"), helloProof("tok-124", "nnnnnnnnnnnnnnnnn", "server-1"))
        assertNotEquals(helloProof("tok-123", "nnnnnnnnnnnnnnnnn", "server-1"), helloProof("tok-123", "nnnnnnnnnnnnnnnnn", "server-2"))
    }

    @Test fun theEncryptedPortProofMatchesThePcToo() {
        assertEquals("b87a710225ba117efe17ae393d97c94a8a0657c469597d8608bb86f66b9096cd", helloTlsProof("tok-123", "nonce-abcdefghijklmnop", "server-1", "a".repeat(64), 48912))
        assertNotEquals(helloTlsProof("tok-123", "nonce-abcdefghijklmnop", "server-1", "a".repeat(64), 48912), helloTlsProof("tok-123", "nonce-abcdefghijklmnop", "server-1", "b".repeat(64), 48912))
    }
}
