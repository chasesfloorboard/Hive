package com.local.hive.mobile.soulseek

import java.io.File

/**
 * Validates audio container magic bytes to protect the device against non-audio,
 * malicious, or corrupted payloads delivered over peer-to-peer or remote links.
 */
object AudioSecurity {

    fun isAuthenticAudio(file: File, extension: String = ""): Boolean {
        if (!file.exists() || file.length() < 12) return false
        val header = ByteArray(12)
        val read = runCatching {
            file.inputStream().use { it.read(header) }
        }.getOrDefault(-1)
        if (read < 4) return false
        return isAuthenticAudioHeader(header, read, extension)
    }

    fun isAuthenticAudioHeader(header: ByteArray, length: Int, extension: String = ""): Boolean {
        if (length < 4) return false
        val ext = extension.lowercase().trimStart('.')

        val isMp3 = (header[0] == 0x49.toByte() && header[1] == 0x44.toByte() && header[2] == 0x33.toByte()) || // "ID3"
                (header[0] == 0xFF.toByte() && (header[1].toInt() and 0xE0) == 0xE0) // MPEG frame sync
        val isFlac = header[0] == 0x66.toByte() && header[1] == 0x4C.toByte() && header[2] == 0x61.toByte() && header[3] == 0x43.toByte() // "fLaC"
        val isOgg = header[0] == 0x4F.toByte() && header[1] == 0x67.toByte() && header[2] == 0x67.toByte() && header[3] == 0x53.toByte() // "OggS"
        val isWav = length >= 12 &&
                header[0] == 0x52.toByte() && header[1] == 0x49.toByte() && header[2] == 0x46.toByte() && header[3] == 0x46.toByte() && // "RIFF"
                header[8] == 0x57.toByte() && header[9] == 0x41.toByte() && header[10] == 0x56.toByte() && header[11] == 0x45.toByte() // "WAVE"
        val isAiff = length >= 12 &&
                header[0] == 0x46.toByte() && header[1] == 0x4F.toByte() && header[2] == 0x52.toByte() && header[3] == 0x4D.toByte() && // "FORM"
                header[8] == 0x41.toByte() && header[9] == 0x49.toByte() && header[10] == 0x46.toByte() && (header[11] == 0x46.toByte() || header[11] == 0x43.toByte())
        val isMp4 = (length >= 8 && header[4] == 0x66.toByte() && header[5] == 0x74.toByte() && header[6] == 0x79.toByte() && header[7] == 0x70.toByte()) || // "ftyp"
                (header[0] == 0xFF.toByte() && (header[1].toInt() and 0xF0) == 0xF0) // ADTS AAC sync

        return when (ext) {
            "mp3" -> isMp3
            "flac" -> isFlac
            "wav" -> isWav
            "ogg", "opus" -> isOgg
            "m4a", "aac", "alac" -> isMp4
            "aif", "aiff" -> isAiff
            else -> isMp3 || isFlac || isOgg || isWav || isMp4 || isAiff
        }
    }
}
