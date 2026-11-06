package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupSecretsTest {
    private val soulseek = """<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="username">someone</string>
    <string name="password">hunter2 &amp; more</string>
    <string name="quality">mp3</string>
</map>
"""

    @Test fun passwordsNeverGoIntoACopyButSettingsDo() {
        val keys = Secrets.keysFor("soulseek.xml")!!
        val copy = Secrets.strip(soulseek, keys)
        assertFalse("hunter2" in copy)
        assertTrue("someone" in copy && "mp3" in copy)
        // Restoring keeps this phone's own password.
        val own = Secrets.entries(soulseek, keys)
        val restored = Secrets.put(copy, own, keys)
        assertTrue("hunter2" in restored && "mp3" in restored)
        assertEquals(1, Regex("name=\"password\"").findAll(restored).count())
    }

    @Test fun everySignInFileIsCovered() {
        assertEquals(setOf("soulseek.xml", "spotify.xml", "apple-music.xml", "scrobbling.xml"), Secrets.FILES.keys)
    }
}
