package com.local.hive.mobile.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Shared real-time 64-band audio spectrum bus (20 Hz – 16 kHz, normalized 0..1 on a -80..0 dB scale,
 * matching Hive Desktop's GStreamer spectrum element).
 *
 * Analysis runs ONLY while at least one observer (Visualizer tab or a plugin) is attached via [acquire],
 * so normal playback incurs zero FFT CPU cost and requires zero RECORD_AUDIO permission.
 */
object SpectrumBus {
    const val BANDS = 64
    private val observerCount = AtomicInteger(0)
    private val _levels = MutableStateFlow(FloatArray(BANDS))
    val levels: StateFlow<FloatArray> = _levels.asStateFlow()

    val active: Boolean get() = observerCount.get() > 0

    fun acquire() {
        observerCount.incrementAndGet()
    }

    fun release() {
        val left = observerCount.decrementAndGet().coerceAtLeast(0)
        if (left == 0) {
            observerCount.set(0)
            _levels.value = FloatArray(BANDS)
        }
    }

    internal fun publish(bands: FloatArray) {
        if (observerCount.get() > 0) {
            _levels.value = bands
        }
    }

    internal fun silence() {
        if (observerCount.get() > 0) {
            _levels.value = FloatArray(BANDS)
        }
    }
}

/**
 * Pure radix-2 FFT and log-spaced 64-band spectrum computation (20 Hz .. 16 kHz),
 * kept free of Android types so unit tests exercise the exact DSP math.
 */
object SpectrumFft {
    const val FFT_SIZE = 2048
    const val BANDS = SpectrumBus.BANDS
    private const val MIN_HZ = 20.0
    private const val MAX_HZ = 16_000.0
    private const val FLOOR_DB = -80.0

    private val hann = FloatArray(FFT_SIZE) { i ->
        (0.5 * (1.0 - cos(2.0 * PI * i / (FFT_SIZE - 1)))).toFloat()
    }

    /** In-place iterative Cooley-Tukey radix-2 FFT for power-of-two arrays. */
    fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val half = len shr 1
            val ang = -2.0 * PI / len
            val wLenRe = cos(ang).toFloat()
            val wLenIm = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var wRe = 1f
                var wIm = 0f
                for (k in 0 until half) {
                    val uRe = real[i + k]
                    val uIm = imag[i + k]
                    val vRe = real[i + k + half] * wRe - imag[i + k + half] * wIm
                    val vIm = real[i + k + half] * wIm + imag[i + k + half] * wRe
                    real[i + k] = uRe + vRe
                    imag[i + k] = uIm + vIm
                    real[i + k + half] = uRe - vRe
                    imag[i + k + half] = uIm - vIm
                    val nextRe = wRe * wLenRe - wIm * wLenIm
                    wIm = wRe * wLenIm + wIm * wLenRe
                    wRe = nextRe
                }
                i += len
            }
            len = len shl 1
        }
    }

    /** Computes 64 log-spaced bands in [0f, 1f] from [FFT_SIZE] mono PCM samples in [-1, 1]. */
    fun compute64Bands(mono: FloatArray, sampleRate: Int): FloatArray {
        val n = FFT_SIZE
        val re = FloatArray(n)
        val im = FloatArray(n)
        val count = minOf(mono.size, n)
        for (i in 0 until count) {
            re[i] = mono[i] * hann[i]
        }
        fft(re, im)

        val nyquist = (sampleRate.coerceAtLeast(8_000) / 2.0)
        val hiHz = minOf(MAX_HZ, nyquist * 0.98)
        val loHz = minOf(MIN_HZ, hiHz * 0.5)
        val ratio = hiHz / loHz
        val binHz = sampleRate.coerceAtLeast(8_000).toDouble() / n
        val maxBin = n / 2 - 1
        // Hann window coherent gain is 0.5; multiply magnitude by 2/(N/2) = 4/N so full-scale sine ≈ 0 dB.
        val scale = 4.0 / n

        val out = FloatArray(BANDS)
        for (b in 0 until BANDS) {
            val f0 = loHz * ratio.pow(b.toDouble() / BANDS)
            val f1 = loHz * ratio.pow((b + 1).toDouble() / BANDS)
            val loBin = (f0 / binHz).toInt().coerceIn(1, maxBin)
            val hiBin = kotlin.math.ceil(f1 / binHz).toInt().coerceIn(loBin, maxBin)
            var peakMag = 0.0
            for (k in loBin..hiBin) {
                val mag = sqrt((re[k] * re[k] + im[k] * im[k]).toDouble()) * scale
                if (mag > peakMag) peakMag = mag
            }
            val db = if (peakMag > 1e-6) 20.0 * log10(peakMag) else FLOOR_DB
            out[b] = ((db - FLOOR_DB) / -FLOOR_DB).toFloat().coerceIn(0f, 1f)
        }
        return out
    }
}

/**
 * Pass-through ExoPlayer AudioProcessor that taps decoded PCM right after the equaliser
 * and publishes real-time 64-band spectrum frames to [SpectrumBus] when observed.
 */
@UnstableApi
class SpectrumProcessor : BaseAudioProcessor() {
    private var channels = 2
    private var rate = 44_100
    private var encoding = C.ENCODING_PCM_16BIT

    private val ring = FloatArray(SpectrumFft.FFT_SIZE)
    private var writePos = 0
    private var hopCount = 0
    private val ordered = FloatArray(SpectrumFft.FFT_SIZE)
    private var hopSize = 512

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        val supported = inputAudioFormat.encoding == C.ENCODING_PCM_16BIT ||
            inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT ||
            inputAudioFormat.encoding == C.ENCODING_PCM_24BIT ||
            inputAudioFormat.encoding == C.ENCODING_PCM_32BIT
        if (!supported) {
            // Passthrough gracefully rather than rejecting playback on exotic encodings.
            return AudioProcessor.AudioFormat.NOT_SET
        }
        channels = inputAudioFormat.channelCount.coerceAtLeast(1)
        rate = inputAudioFormat.sampleRate.coerceAtLeast(8_000)
        encoding = inputAudioFormat.encoding
        // Scale FFT hop size to keep ~60 Hz cadence across 44.1 / 48 / 96 / 192 kHz Hi-Res tracks.
        hopSize = (rate / 60).coerceIn(512, 4096)
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val remaining = inputBuffer.remaining()
        if (remaining == 0) return

        // Fast zero-overhead passthrough whenever no Visualizer or plugin is watching.
        if (SpectrumBus.active) {
            val dup = inputBuffer.duplicate().order(ByteOrder.nativeOrder())
            val bytesPerSample = when (encoding) {
                C.ENCODING_PCM_FLOAT, C.ENCODING_PCM_32BIT -> 4
                C.ENCODING_PCM_24BIT -> 3
                else -> 2
            }
            val bytesPerFrame = bytesPerSample * channels
            val frames = remaining / bytesPerFrame
            val invCh = 1f / channels
            for (f in 0 until frames) {
                var sum = 0f
                for (c in 0 until channels) {
                    sum += when (encoding) {
                        C.ENCODING_PCM_FLOAT -> dup.getFloat()
                        C.ENCODING_PCM_32BIT -> dup.getInt() / 2147483648f
                        C.ENCODING_PCM_24BIT -> {
                            val b0 = dup.get().toInt() and 0xFF
                            val b1 = dup.get().toInt() and 0xFF
                            val b2 = dup.get().toInt() // signed MSB
                            ((b2 shl 16) or (b1 shl 8) or b0) / 8388608f
                        }
                        else -> dup.getShort() / 32768f
                    }
                }
                ring[writePos] = sum * invCh
                writePos = (writePos + 1) and (SpectrumFft.FFT_SIZE - 1)
                hopCount++
                if (hopCount >= hopSize) {
                    hopCount = 0
                    val n = SpectrumFft.FFT_SIZE
                    val tail = n - writePos
                    System.arraycopy(ring, writePos, ordered, 0, tail)
                    if (writePos > 0) System.arraycopy(ring, 0, ordered, tail, writePos)
                    SpectrumBus.publish(SpectrumFft.compute64Bands(ordered, rate))
                }
            }
        }

        val out = replaceOutputBuffer(remaining)
        out.put(inputBuffer)
        out.flip()
    }

    override fun onFlush() {
        ring.fill(0f)
        writePos = 0
        hopCount = 0
    }

    override fun onReset() {
        ring.fill(0f)
        writePos = 0
        hopCount = 0
    }
}
