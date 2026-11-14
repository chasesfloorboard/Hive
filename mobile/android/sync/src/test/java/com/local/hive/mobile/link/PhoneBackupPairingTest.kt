package com.local.hive.mobile.link
import com.local.hive.mobile.link.PairingPrefs as Pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneBackupPairingTest {
    private val old = """<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="token">OLD</string>
    <boolean name="songSync" value="true" />
    <int name="port" value="48765" />
    <string name="hosts">10.0.0.2
10.0.0.3</string>
    <string name="deviceId">old-device</string>
</map>"""

    @Test fun aBackupNeverCarriesThePairing() {
        val bare = Pairing.strip(old)
        assertFalse(bare.contains("OLD")); assertFalse(bare.contains("10.0.0.2")); assertFalse(bare.contains("old-device"))
        assertTrue(bare.contains("songSync"))
    }

    @Test fun aRestoreKeepsThisInstallsPairingAndTheCopysSettings() {
        val mine = Pairing.entries("""<map><string name="token">NEW</string><string name="deviceId">new-device</string><int name="port" value="1" /></map>""")
        val restored = Pairing.put(old, mine)
        assertTrue(restored.contains("NEW")); assertTrue(restored.contains("new-device")); assertTrue(restored.contains("songSync"))
        assertFalse(restored.contains("OLD")); assertFalse(restored.contains("old-device"))
        assertEquals(1, Regex("name=\"token\"").findAll(restored).count())
    }
}
