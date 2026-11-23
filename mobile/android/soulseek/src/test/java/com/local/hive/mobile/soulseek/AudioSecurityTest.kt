package com.local.hive.mobile.soulseek

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AudioSecurityTest {

    @Test
    fun `isAuthenticAudio identifies MP3, FLAC, WAV, and OGG headers correctly`() {
        // ID3 header
        val id3 = byteArrayOf(0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
        assertTrue(AudioSecurity.isAuthenticAudioHeader(id3, id3.size, "mp3"))

        // MPEG audio frame sync
        val mpegSync = byteArrayOf(0xFF.toByte(), 0xFB.toByte(), 0x90.toByte(), 0x64.toByte(), 0, 0, 0, 0, 0, 0, 0, 0)
        assertTrue(AudioSecurity.isAuthenticAudioHeader(mpegSync, mpegSync.size, "mp3"))

        // FLAC header "fLaC"
        val flac = byteArrayOf(0x66, 0x4C, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0)
        assertTrue(AudioSecurity.isAuthenticAudioHeader(flac, flac.size, "flac"))

        // WAV header "RIFF....WAVE"
        val wav = byteArrayOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45)
        assertTrue(AudioSecurity.isAuthenticAudioHeader(wav, wav.size, "wav"))

        // OGG header "OggS"
        val ogg = byteArrayOf(0x4F, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0)
        assertTrue(AudioSecurity.isAuthenticAudioHeader(ogg, ogg.size, "ogg"))
        assertTrue(AudioSecurity.isAuthenticAudioHeader(ogg, ogg.size, "opus"))

        // M4A "ftyp"
        val m4a = byteArrayOf(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20)
        assertTrue(AudioSecurity.isAuthenticAudioHeader(m4a, m4a.size, "m4a"))
    }

    @Test
    fun `isAuthenticAudio rejects executables, scripts, and non-audio payloads`() {
        val elf = byteArrayOf(0x7F, 0x45, 0x4C, 0x46, 0, 0, 0, 0, 0, 0, 0, 0) // ELF binary
        assertFalse(AudioSecurity.isAuthenticAudioHeader(elf, elf.size, "mp3"))

        val script = "#!/bin/bash\n".toByteArray()
        assertFalse(AudioSecurity.isAuthenticAudioHeader(script, script.size, "flac"))

        val html = "<html><body>".toByteArray()
        assertFalse(AudioSecurity.isAuthenticAudioHeader(html, html.size, "mp3"))

        assertFalse(AudioSecurity.isAuthenticAudioHeader(ByteArray(2), 2, "mp3"))
    }

    @Test
    fun `isAuthenticAudio validates File on disk`() {
        val tmp = File.createTempFile("test_audio_", ".flac")
        try {
            tmp.writeBytes(byteArrayOf(0x66, 0x4C, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
            assertTrue(AudioSecurity.isAuthenticAudio(tmp, "flac"))

            tmp.writeBytes("malicious executable content".toByteArray())
            assertFalse(AudioSecurity.isAuthenticAudio(tmp, "flac"))
        } finally {
            tmp.delete()
        }
    }
}
