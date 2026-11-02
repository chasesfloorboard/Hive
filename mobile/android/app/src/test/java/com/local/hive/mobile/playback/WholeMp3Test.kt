package com.local.hive.mobile.playback

import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.Log
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp3.Mp3Extractor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.math.abs

class WholeMp3Test {
    @Before fun offThePhone() {
        Log.setLogLevel(Log.LOG_LEVEL_OFF)
        // Media3 asks Build.FINGERPRINT whether it runs in a test; off a phone that's null and throws.
        ParsableByteArray.setShouldEnforceLimitOnLegacyMethods(true)
    }

    @Test fun androidsReaderStopsWhereTheHeaderSays() {
        // The file this guards against: what Android's own reader does with it.
        assertEquals(60, extract(Mp3Extractor(), mp3(audioFrames = 120, xingFrames = 60)).times.size)
    }

    @Test fun anUndercountingHeaderStillPlaysEveryFrame() {
        val got = extract(WholeMp3Extractor(), mp3(audioFrames = 120, xingFrames = 60))
        assertEquals(120, got.times.size)
        // Timestamps carry on across where the header ended, a frame apart.
        got.times.zipWithNext { a, b -> assertTrue("$a -> $b", abs(b - a - FRAME_US) <= 2) }
        // And the length becomes the whole file's (estimated from what was read: within 3%).
        val whole = got.maps.last().durationUs
        assertTrue("$whole", abs(whole - 120 * FRAME_US) < 120 * FRAME_US * 0.03)
    }

    @Test fun aRightHeaderAndTrailingTagsChangeNothing() {
        val got = extract(WholeMp3Extractor(), mp3(audioFrames = 120, xingFrames = 120, trailing = 128))
        assertEquals(120, got.times.size)
        assertEquals(1, got.maps.size)
    }

    private class Got(val times: MutableList<Long> = mutableListOf(), val maps: MutableList<SeekMap> = mutableListOf())

    private fun extract(extractor: Extractor, bytes: ByteArray): Got {
        val got = Got()
        val track = object : TrackOutput {
            private val scratch = ByteArray(4096)
            override fun format(format: Format) {}
            override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int) =
                input.read(scratch, 0, minOf(length, scratch.size))
            override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) = data.skipBytes(length)
            override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) { got.times += timeUs }
        }
        extractor.init(object : ExtractorOutput {
            override fun track(id: Int, type: Int) = track
            override fun endTracks() {}
            override fun seekMap(seekMap: SeekMap) { got.maps += seekMap }
        })
        var at = 0
        val reader = object : DataReader {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (at >= bytes.size) return C.RESULT_END_OF_INPUT
                val n = minOf(length, bytes.size - at)
                System.arraycopy(bytes, at, buffer, offset, n); at += n
                return n
            }
        }
        val input = DefaultExtractorInput(reader, 0, bytes.size.toLong())
        while (true) {
            val result = extractor.read(input, PositionHolder())
            assertTrue(result != Extractor.RESULT_SEEK)
            if (result == Extractor.RESULT_END_OF_INPUT) break
        }
        return got
    }

    /** MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo: a Xing frame counting [xingFrames], then [audioFrames]. */
    private fun mp3(audioFrames: Int, xingFrames: Int, trailing: Int = 0): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun frame() = ByteArray(FRAME_BYTES).also { it[0] = 0xFF.toByte(); it[1] = 0xFB.toByte(); it[2] = 0x90.toByte() }
        val xing = frame()
        java.nio.ByteBuffer.wrap(xing, 36, 16).put("Xing".toByteArray()).putInt(0x3).putInt(xingFrames).putInt(FRAME_BYTES * (1 + xingFrames))
        out.write(xing)
        repeat(audioFrames) { out.write(frame()) }
        out.write(ByteArray(trailing))
        return out.toByteArray()
    }

    companion object {
        const val FRAME_BYTES = 417
        const val FRAME_US = 1152 * 1_000_000L / 44_100
    }
}
