package com.local.hive.mobile.playback

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.SystemClock
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
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Timestamped circular timeline of 64-band spectrum frames.
 *
 * ExoPlayer's `DefaultAudioSink` calls `AudioProcessor.queueInput()` in bursty refill chunks
 * (~100–250 ms at once) roughly ~230–400 ms AHEAD of what reaches the speakers/Bluetooth.
 * Storing every FFT hop with its exact PCM stream timestamp and sampling along a smooth,
 * burst-floor-locked playhead eliminates both burst stutter (dropped frames) and audio/visual
 * desync. Kept pure-JVM (no Android APIs) so unit tests verify the exact timing behavior.
 */
class SpectrumTimeline(private val capacity: Int = CAPACITY) {
    private val timesMs = DoubleArray(capacity)
    private val frames = Array(capacity) { FloatArray(SpectrumBus.BANDS) }
    private var head = 0
    private var count = 0
    private var lastWallMs = 0L
    private var playheadMs = -1.0
    private var lastSampleWallMs = 0L
    private var minLeadWindow = Double.POSITIVE_INFINITY
    private var minLeadWindowStartMs = 0L

    @Synchronized
    fun push(streamMs: Double, wallMs: Long, bands: FloatArray) {
        if (count > 0) {
            val prevIdx = (head - 1 + capacity) % capacity
            if (streamMs < timesMs[prevIdx]) {
                clearLocked()
            }
        }
        val n = minOf(bands.size, SpectrumBus.BANDS)
        val dst = frames[head]
        System.arraycopy(bands, 0, dst, 0, n)
        if (n < SpectrumBus.BANDS) dst.fill(0f, n, SpectrumBus.BANDS)
        timesMs[head] = streamMs
        head = (head + 1) % capacity
        if (count < capacity) count++
        lastWallMs = wallMs
    }

    @Synchronized
    fun clear() {
        clearLocked()
    }

    private fun clearLocked() {
        head = 0
        count = 0
        lastWallMs = 0L
        playheadMs = -1.0
        lastSampleWallMs = 0L
        minLeadWindow = Double.POSITIVE_INFINITY
        minLeadWindowStartMs = 0L
    }

    /**
     * Writes the time-aligned, linearly interpolated 64-band spectrum for [nowWallMs] into [out].
     * Returns true when active audio data was written, false when silent/paused/stale.
     */
    @Synchronized
    fun sample(
        nowWallMs: Long,
        isPlaying: Boolean,
        speed: Float,
        targetLagMs: Double,
        out: FloatArray,
    ): Boolean {
        if (!isPlaying || count == 0 || (lastWallMs > 0L && nowWallMs - lastWallMs > STALE_AFTER_MS)) {
            out.fill(0f)
            if (!isPlaying) {
                playheadMs = -1.0
                lastSampleWallMs = 0L
                minLeadWindow = Double.POSITIVE_INFINITY
            }
            return false
        }

        val oldestIdx = (head - count + capacity) % capacity
        val newestIdx = (head - 1 + capacity) % capacity
        val oldestMs = timesMs[oldestIdx]
        val newestMs = timesMs[newestIdx]
        val lag = targetLagMs.coerceIn(0.0, 1_500.0)

        if (playheadMs < 0.0) {
            playheadMs = (newestMs - lag).coerceIn(oldestMs, newestMs)
            lastSampleWallMs = nowWallMs
            minLeadWindow = newestMs - playheadMs
            minLeadWindowStartMs = nowWallMs
        } else {
            val dtMs = (nowWallMs - lastSampleWallMs).coerceIn(0L, 120L).toDouble()
            lastSampleWallMs = nowWallMs
            playheadMs += dtMs * speed.coerceIn(0.25f, 4f)

            val lead = newestMs - playheadMs
            if (lead < minLeadWindow) minLeadWindow = lead

            when {
                playheadMs < oldestMs -> playheadMs = oldestMs
                playheadMs > newestMs -> playheadMs = newestMs
                lead > lag + CATCHUP_THRESHOLD_MS -> {
                    playheadMs = (newestMs - lag).coerceIn(oldestMs, newestMs)
                    minLeadWindow = newestMs - playheadMs
                    minLeadWindowStartMs = nowWallMs
                }
            }

            if (nowWallMs - minLeadWindowStartMs >= PLL_WINDOW_MS) {
                val err = minLeadWindow - lag
                if (abs(err) > PLL_DEADBAND_MS) {
                    playheadMs = (playheadMs + err * PLL_GAIN).coerceIn(oldestMs, newestMs)
                }
                minLeadWindow = newestMs - playheadMs
                minLeadWindowStartMs = nowWallMs
            }
        }

        // Binary search over chronological logical indices [0, count - 1]
        var lo = 0
        var hi = count - 1
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            val tMid = timesMs[(oldestIdx + mid) % capacity]
            if (tMid < playheadMs) lo = mid + 1 else hi = mid
        }

        val rightSlot = (oldestIdx + lo) % capacity
        if (lo == 0 || timesMs[rightSlot] <= playheadMs) {
            System.arraycopy(frames[rightSlot], 0, out, 0, minOf(out.size, SpectrumBus.BANDS))
            return true
        }
        val leftSlot = (oldestIdx + lo - 1) % capacity
        val t0 = timesMs[leftSlot]
        val t1 = timesMs[rightSlot]
        val frac = if (t1 > t0) ((playheadMs - t0) / (t1 - t0)).toFloat().coerceIn(0f, 1f) else 0f
        val a = frames[leftSlot]
        val b = frames[rightSlot]
        val n = minOf(out.size, SpectrumBus.BANDS)
        for (i in 0 until n) {
            out[i] = a[i] + (b[i] - a[i]) * frac
        }
        return true
    }

    companion object {
        const val CAPACITY = 256
        private const val STALE_AFTER_MS = 700L
        private const val CATCHUP_THRESHOLD_MS = 450.0
        private const val PLL_WINDOW_MS = 400L
        private const val PLL_DEADBAND_MS = 15.0
        private const val PLL_GAIN = 0.25
    }
}

/**
 * Shared real-time 64-band audio spectrum bus (20 Hz – 16 kHz, normalized 0..1 on a -80..0 dB scale,
 * matching Hive Desktop's GStreamer spectrum element).
 *
 * Analysis runs ONLY while at least one observer (Visualizer tab or a plugin) is attached via [acquire],
 * so normal playback incurs zero FFT CPU cost and requires zero RECORD_AUDIO permission.
 */
object SpectrumBus {
    const val BANDS = 64
    // Target burst-trough lead: DefaultAudioSink keeps a ~250 ms PCM AudioTrack buffer refilled in ~100 ms
    // chunks, so the pre-refill trough sits at ~140 ms on speakers/wired and ~280 ms over Bluetooth/Android Auto.
    private const val BASE_AUDIO_TRACK_LEAD_MS = 140.0
    private const val BLUETOOTH_EXTRA_LATENCY_MS = 140.0

    private val observerCount = AtomicInteger(0)
    private val nextProducerId = AtomicInteger(1)
    @Volatile private var activeProducerId = 0
    @Volatile private var windowHalfMs = (SpectrumFft.FFT_SIZE * 500.0) / 48_000.0

    private val timeline = SpectrumTimeline()
    private val _levels = MutableStateFlow(FloatArray(BANDS))
    val levels: StateFlow<FloatArray> = _levels.asStateFlow()

    val active: Boolean get() = observerCount.get() > 0

    internal fun allocateProducerId(): Int = nextProducerId.getAndIncrement()

    internal fun setSampleRate(sampleRate: Int) {
        val sr = sampleRate.coerceAtLeast(8_000)
        windowHalfMs = (SpectrumFft.FFT_SIZE * 500.0) / sr
    }

    fun acquire() {
        if (observerCount.getAndIncrement() == 0) {
            timeline.clear()
        }
    }

    fun release() {
        val left = observerCount.decrementAndGet().coerceAtLeast(0)
        if (left == 0) {
            observerCount.set(0)
            activeProducerId = 0
            timeline.clear()
            _levels.value = FloatArray(BANDS)
        }
    }

    internal fun publish(producerId: Int, streamMs: Double, wallMs: Long, bands: FloatArray) {
        if (observerCount.get() <= 0) return
        if (activeProducerId != producerId) {
            // Switch producer cleanly (e.g. crossfade companion taking over)
            activeProducerId = producerId
            timeline.clear()
        }
        timeline.push(streamMs, wallMs, bands)
    }

    internal fun resetStream(producerId: Int) {
        if (activeProducerId == producerId || activeProducerId == 0) {
            timeline.clear()
        }
    }

    /**
     * Samples the latency-compensated, interpolated 64-band spectrum for the current display frame
     * directly into [out] without allocating or triggering Compose state churn.
     */
    fun sampleNow(
        isPlaying: Boolean,
        speed: Float = 1f,
        targetLagMs: Double = BASE_AUDIO_TRACK_LEAD_MS,
        out: FloatArray = FloatArray(BANDS),
    ): FloatArray {
        // Subtract the symmetric Hann window's half-length group delay so the 4096-sample bass
        // resolution adds zero visual latency relative to the speakers/Bluetooth output.
        val effectiveLagMs = (targetLagMs - windowHalfMs).coerceAtLeast(0.0)
        timeline.sample(
            nowWallMs = SystemClock.elapsedRealtime(),
            isPlaying = isPlaying,
            speed = speed,
            targetLagMs = effectiveLagMs,
            out = out,
        )
        return out
    }

    /**
     * Estimates AudioTrack + output route latency so visual bars hit in sync with what you hear
     * on phone speakers, wired headphones, Bluetooth A2DP, or Android Auto car audio.
     */
    fun estimatedOutputLatencyMs(context: Context): Double {
        if (CarLog.carConnected) return BASE_AUDIO_TRACK_LEAD_MS + BLUETOOTH_EXTRA_LATENCY_MS
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return BASE_AUDIO_TRACK_LEAD_MS
        val devices = runCatching { am.getDevices(AudioManager.GET_DEVICES_OUTPUTS) }.getOrNull().orEmpty()
        val hasWireless = devices.any { d ->
            d.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                d.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                d.type == AudioDeviceInfo.TYPE_BLE_SPEAKER
        }
        return if (hasWireless) BASE_AUDIO_TRACK_LEAD_MS + BLUETOOTH_EXTRA_LATENCY_MS else BASE_AUDIO_TRACK_LEAD_MS
    }
}

/**
 * Pure radix-2 FFT and log-spaced 64-band spectrum computation (35 Hz .. 12 kHz),
 * kept free of Android types so unit tests exercise the exact DSP math.
 *
 * Uses a 4096-sample Hann window (23.4 Hz main lobe at 48 kHz so low kick pitch sweeps
 * resolve cleanly) zero-padded 2x to an 8192-point FFT (5.86 Hz/bin exact sinc interpolation)
 * with fractional sub-bin interpolation on narrow bass bands so adjacent bars never clone
 * the same FFT bin.
 */
object SpectrumFft {
    const val FFT_SIZE = 4096
    const val ZERO_PAD_SIZE = 8192
    const val BANDS = SpectrumBus.BANDS
    private const val MIN_HZ = 35.0
    private const val MAX_HZ = 12_000.0
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
    fun compute64Bands(
        mono: FloatArray,
        sampleRate: Int,
        re: FloatArray = FloatArray(ZERO_PAD_SIZE),
        im: FloatArray = FloatArray(ZERO_PAD_SIZE),
        out: FloatArray = FloatArray(BANDS),
    ): FloatArray {
        val n = ZERO_PAD_SIZE
        val workRe = if (re.size == n) re else FloatArray(n)
        val workIm = if (im.size == n) im else FloatArray(n)
        val count = minOf(mono.size, FFT_SIZE)
        for (i in 0 until count) {
            workRe[i] = mono[i] * hann[i]
            workIm[i] = 0f
        }
        for (i in count until n) {
            workRe[i] = 0f
            workIm[i] = 0f
        }
        fft(workRe, workIm)

        val sr = sampleRate.coerceAtLeast(8_000).toDouble()
        val nyquist = sr / 2.0
        val hiHz = minOf(MAX_HZ, nyquist * 0.98)
        val loHz = minOf(MIN_HZ, hiHz * 0.5)
        val ratio = hiHz / loHz
        val binHz = sr / n
        val maxBin = n / 2 - 1
        // Hann coherent gain is 0.5 over FFT_SIZE non-zero samples (unchanged by zero-padding),
        // so multiplying magnitude by 4 / FFT_SIZE puts a full-scale sine wave at 0 dB.
        val scale = 4.0 / FFT_SIZE

        fun magAt(k: Int): Double {
            val r = workRe[k].toDouble()
            val j = workIm[k].toDouble()
            return sqrt(r * r + j * j) * scale
        }

        for (b in 0 until BANDS) {
            val f0 = loHz * ratio.pow(b.toDouble() / BANDS)
            val f1 = loHz * ratio.pow((b + 1).toDouble() / BANDS)
            val peakMag = if ((f1 - f0) / binHz < 1.25) {
                val fc = sqrt(f0 * f1)
                val pos = (fc / binHz).coerceIn(1.0, (maxBin - 1).toDouble())
                val lo = pos.toInt()
                val frac = pos - lo
                val m0 = magAt(lo)
                val m1 = magAt(lo + 1)
                m0 + (m1 - m0) * frac
            } else {
                val loBin = (f0 / binHz).toInt().coerceIn(1, maxBin)
                val hiBin = kotlin.math.ceil(f1 / binHz).toInt().coerceIn(loBin, maxBin)
                var best = 0.0
                for (k in loBin..hiBin) {
                    val m = magAt(k)
                    if (m > best) best = m
                }
                best
            }
            val db = if (peakMag > 1e-6) 20.0 * log10(peakMag) else FLOOR_DB
            out[b] = ((db - FLOOR_DB) / -FLOOR_DB).toFloat().coerceIn(0f, 1f)
        }
        return out
    }
}

/**
 * Pass-through ExoPlayer AudioProcessor that taps decoded PCM right after the equaliser
 * and pushes timestamped 64-band spectrum frames to [SpectrumBus] when observed.
 */
@UnstableApi
class SpectrumProcessor : BaseAudioProcessor() {
    private val producerId = SpectrumBus.allocateProducerId()
    private var channels = 2
    private var rate = 44_100
    private var encoding = C.ENCODING_PCM_16BIT

    private val ring = FloatArray(SpectrumFft.FFT_SIZE)
    private var writePos = 0
    private var hopCount = 0
    private var totalFramesProcessed = 0L
    private val ordered = FloatArray(SpectrumFft.FFT_SIZE)
    private val fftRe = FloatArray(SpectrumFft.ZERO_PAD_SIZE)
    private val fftIm = FloatArray(SpectrumFft.ZERO_PAD_SIZE)
    private val fftBands = FloatArray(SpectrumBus.BANDS)
    private var hopSize = 640

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
        // ~75 Hz FFT cadence captures fast EDM kick pitch drops across 44.1 / 48 / 96 / 192 kHz tracks.
        hopSize = (rate / 75).coerceIn(512, 4096)
        SpectrumBus.setSampleRate(rate)
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
            val wallMs = SystemClock.elapsedRealtime()
            val msPerFrame = 1000.0 / rate
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
                totalFramesProcessed++
                hopCount++
                if (hopCount >= hopSize) {
                    hopCount = 0
                    val n = SpectrumFft.FFT_SIZE
                    val tail = n - writePos
                    System.arraycopy(ring, writePos, ordered, 0, tail)
                    if (writePos > 0) System.arraycopy(ring, 0, ordered, tail, writePos)
                    SpectrumFft.compute64Bands(ordered, rate, fftRe, fftIm, fftBands)
                    SpectrumBus.publish(producerId, totalFramesProcessed * msPerFrame, wallMs, fftBands)
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
        totalFramesProcessed = 0L
        SpectrumBus.resetStream(producerId)
    }

    override fun onReset() {
        ring.fill(0f)
        writePos = 0
        hopCount = 0
        totalFramesProcessed = 0L
        SpectrumBus.resetStream(producerId)
    }
}
