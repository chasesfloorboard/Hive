package com.local.hive.mobile.playback

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.SeekPoint
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.extractor.text.SubtitleParser

/** Android's extractors, with every MP3 read by [WholeMp3Extractor]. */
class HiveExtractorsFactory(private val base: ExtractorsFactory = DefaultExtractorsFactory()) : ExtractorsFactory {
    override fun createExtractors(): Array<Extractor> = base.createExtractors().map(::whole).toTypedArray()
    override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> =
        base.createExtractors(uri, responseHeaders).map(::whole).toTypedArray()
    override fun setSubtitleParserFactory(factory: SubtitleParser.Factory): ExtractorsFactory = apply { base.setSubtitleParserFactory(factory) }
    private fun whole(e: Extractor) = if (e is Mp3Extractor) WholeMp3Extractor(e) else e
}

/**
 * An MP3 played to its last frame. A VBR MP3's Xing header gives the audio's length in bytes, and
 * Android's MP3 reader stops there; some files hold more than their header counts (a rip or an
 * edit that rewrote the audio but not the header), and the song ended early: Sunn O)))'s 15-minute
 * "Why Dost Thou Hide Thyself In Clouds?" stopped at 13. When the reader ends with audio still
 * left in the file, a second reader carries on from there, its timestamps following on, and the
 * song's length is stretched to the whole file (seeks into the rest land in proportion).
 */
class WholeMp3Extractor(private val head: Mp3Extractor = Mp3Extractor()) : Extractor {
    private lateinit var output: ExtractorOutput
    private val track = Track()
    private var tail: Mp3Extractor? = null
    private var headMap: SeekMap? = null
    /** Where the header said the audio ends, once the reader stopped there short of the file's end. */
    private var restStart = C.INDEX_UNSET.toLong()
    private var restLength = 0L
    private var firstSamplePosition = C.INDEX_UNSET.toLong()

    override fun sniff(input: ExtractorInput) = head.sniff(input)

    override fun init(output: ExtractorOutput) {
        this.output = output
        head.init(object : ExtractorOutput by output {
            override fun track(id: Int, type: Int): TrackOutput = track.also { it.real = output.track(id, type) }
            override fun seekMap(seekMap: SeekMap) { headMap = seekMap; output.seekMap(seekMap) }
        })
    }

    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        val tail = tail
        if (tail != null) {
            // Trailing tags (an APE tag with a cover) aren't audio: the song ends there.
            return runCatching { tail.read(input, seekPosition) }.getOrDefault(Extractor.RESULT_END_OF_INPUT)
        }
        val result = head.read(input, seekPosition)
        // Where the audio starts (within a frame), past any ID3 tag and the Xing frame.
        if (firstSamplePosition == C.INDEX_UNSET.toLong() && track.lastTimeUs != C.TIME_UNSET) firstSamplePosition = input.position
        if (result != Extractor.RESULT_END_OF_INPUT) return result
        val length = input.length
        if (length == C.LENGTH_UNSET.toLong() || length - input.position < MIN_REST_BYTES || track.lastTimeUs == C.TIME_UNSET) return result
        if (restStart == C.INDEX_UNSET.toLong()) stretch(input.position, length)
        startTail(track.nextTimeUs())
        return Extractor.RESULT_CONTINUE
    }

    /** The song's length, and seeking, over the whole file: the rest at the bitrate of what was read. */
    private fun stretch(at: Long, length: Long) {
        restStart = at; restLength = length - at
        val map = headMap ?: return
        val headUs = map.durationUs
        val readBytes = at - firstSamplePosition.coerceAtLeast(0)
        if (headUs == C.TIME_UNSET || headUs <= 0 || readBytes <= 0) return
        val restUs = (restLength.toDouble() * headUs / readBytes).toLong()
        val whole = Stretched(map, headUs, at, restLength, headUs + restUs)
        output.seekMap(whole)
        track.real?.durationUs(whole.durationUs)
    }

    private fun startTail(offsetUs: Long) {
        track.offsetUs = offsetUs
        tail = Mp3Extractor(Mp3Extractor.FLAG_DISABLE_ID3_METADATA).also { t ->
            t.disableSeeking()
            t.init(object : ExtractorOutput {
                // Its own length (unknown, reading without a header) isn't the song's.
                override fun track(id: Int, type: Int): TrackOutput = object : TrackOutput by track { override fun durationUs(durationUs: Long) {} }
                override fun endTracks() {}
                override fun seekMap(seekMap: SeekMap) {}
            })
        }
    }

    override fun seek(position: Long, timeUs: Long) {
        track.lastTimeUs = C.TIME_UNSET
        if (restStart != C.INDEX_UNSET.toLong() && position >= restStart) {
            startTail(timeUs)
        } else {
            tail = null
            track.offsetUs = 0
            head.seek(position, timeUs)
        }
    }

    override fun release() { head.release(); tail?.release() }

    override fun getUnderlyingImplementation(): Extractor = head

    /** The one audio track, both readers' samples in turn: the second's shifted to follow the first. */
    private class Track : TrackOutput {
        var real: TrackOutput? = null
        var offsetUs = 0L
        var lastTimeUs = C.TIME_UNSET
        private var frameUs = 0L
        private var format: Format? = null

        /** Where the next frame starts: the last one's start plus a frame. */
        fun nextTimeUs() = lastTimeUs + frameUs

        // The second reader announces the same audio again (without the encoder delay): kept as first given.
        override fun format(format: Format) { if (this.format == null) { this.format = format; real?.format(format) } }

        override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int) =
            real!!.sampleData(input, length, allowEndOfInput, sampleDataPart)

        override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) =
            real!!.sampleData(data, length, sampleDataPart)

        override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {
            val at = timeUs + offsetUs
            if (lastTimeUs != C.TIME_UNSET && at > lastTimeUs) frameUs = at - lastTimeUs
            lastTimeUs = at
            real!!.sampleMetadata(at, flags, size, offset, cryptoData)
        }

        override fun durationUs(durationUs: Long) { real?.durationUs(durationUs) }
    }

    /** The header's seek map up to where it ends, then the rest of the file in proportion. */
    private class Stretched(private val head: SeekMap, private val headUs: Long, private val restStart: Long, private val restLength: Long, private val wholeUs: Long) : SeekMap {
        override fun isSeekable() = head.isSeekable
        override fun getDurationUs() = wholeUs
        override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints {
            if (timeUs < headUs) return head.getSeekPoints(timeUs)
            val t = timeUs.coerceAtMost(wholeUs)
            val position = restStart + ((t - headUs).toDouble() / (wholeUs - headUs) * restLength).toLong().coerceIn(0, restLength - 1)
            return SeekMap.SeekPoints(SeekPoint(t, position))
        }
    }

    companion object {
        /** Less than this after the header's end is tags, not audio worth reading on. */
        const val MIN_REST_BYTES = 16 * 1024L
    }
}
