package app.cadence.player

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * Pure JVM-testable helpers and models shared between CadenceAndroidPlugin, CadenceMediaService,
 * and CadenceStorageHelper.
 */
object AndroidContracts {
    val AUDIO_EXTENSIONS = setOf(
        "flac", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "mp4", "m4b", "aiff", "aif", "webm"
    )

    val LYRICS_EXTENSIONS = setOf("lrc", "ttml", "qrc", "srt", "txt")

    val SKIP_DIRECTORIES = setOf(
        "node_modules", ".git", ".svn", ".Trash", ".Trashes", "@eaDir", "Android"
    )

    /** Standard Cadence 10-band graphic EQ center frequencies in Hz. */
    val CADENCE_EQ_FREQUENCIES_HZ = doubleArrayOf(
        31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0
    )

    data class EqConfig(
        val enabled: Boolean,
        val preampDb: Double,
        val bandsDb: List<Double>,
    )

    data class QueueTrackInput(
        val uri: String,
        val trackId: Long,
        val title: String,
        val artist: String,
        val album: String,
        val artworkPath: String?,
        val durationSec: Double,
        val replayGainLinear: Double,
    )

    data class WalkedAudioEntry(
        val path: String,
        val size: Long,
        val mtimeMs: Double,
        val hasSidecarLyrics: Boolean,
        val animatedArtPath: String?,
    )

    fun extensionOf(nameOrPath: String): String {
        val clean = nameOrPath.substringAfterLast('/').substringAfterLast('\\')
        val dot = clean.lastIndexOf('.')
        if (dot <= 0 || dot >= clean.length - 1) return ""
        return clean.substring(dot + 1).lowercase()
    }

    fun stemOf(nameOrPath: String): String {
        val clean = nameOrPath.substringAfterLast('/').substringAfterLast('\\')
        val dot = clean.lastIndexOf('.')
        return if (dot > 0) clean.substring(0, dot) else clean
    }

    fun isAudioFileName(name: String): Boolean = AUDIO_EXTENSIONS.contains(extensionOf(name))

    fun isLyricsFileName(name: String): Boolean = LYRICS_EXTENSIONS.contains(extensionOf(name))

    fun animatedArtCandidatesFor(fileName: String): List<String> {
        val stem = stemOf(fileName)
        return listOf(
            "cover.mp4",
            "cover.webm",
            "$stem.mp4",
            "$stem.webm",
            "$stem-animated.mp4",
        )
    }

    fun parseEqConfig(json: JSONObject?): EqConfig {
        if (json == null) {
            return EqConfig(enabled = false, preampDb = 0.0, bandsDb = List(10) { 0.0 })
        }
        val enabled = json.optBoolean("enabled", false)
        val preamp = json.optDouble("preampDb", 0.0).let { if (it.isFinite()) it.coerceIn(-12.0, 12.0) else 0.0 }
        val arr = json.optJSONArray("bandsDb")
        val bands = (0 until 10).map { idx ->
            val raw = arr?.optDouble(idx, 0.0) ?: 0.0
            if (raw.isFinite()) raw.coerceIn(-12.0, 12.0) else 0.0
        }
        return EqConfig(enabled = enabled, preampDb = preamp, bandsDb = bands)
    }

    /**
     * Maps Cadence's 10-band EQ (`[31..16000]` Hz, dB) to an Android Equalizer's hardware bands
     * (whose band count and center frequencies in milliHertz vary per OEM device) by log-frequency
     * interpolation, returning clamped millibel values ready for `Equalizer.setBandLevel`.
     */
    fun mapEqToDeviceMillibels(
        config: EqConfig,
        deviceCenterFreqMilliHz: IntArray,
        minLevelMb: Short,
        maxLevelMb: Short,
    ): ShortArray {
        val out = ShortArray(deviceCenterFreqMilliHz.size)
        if (!config.enabled || deviceCenterFreqMilliHz.isEmpty()) {
            return out
        }

        val minMb = minLevelMb.toInt()
        val maxMb = maxLevelMb.toInt().coerceAtLeast(minMb)

        for (i in deviceCenterFreqMilliHz.indices) {
            val hz = (deviceCenterFreqMilliHz[i].toDouble() / 1000.0).coerceAtLeast(20.0)
            val logHz = ln(hz)
            val bandDb = interpolateLogBandDb(logHz, config.bandsDb)
            val totalMb = ((config.preampDb + bandDb) * 100.0).roundToInt()
            out[i] = totalMb.coerceIn(minMb, maxMb).toShort()
        }
        return out
    }

    private fun interpolateLogBandDb(logHz: Double, bandsDb: List<Double>): Double {
        val freqs = CADENCE_EQ_FREQUENCIES_HZ
        if (bandsDb.isEmpty()) return 0.0
        val firstLog = ln(freqs.first())
        val lastLog = ln(freqs.last())
        if (logHz <= firstLog) return bandsDb.first()
        if (logHz >= lastLog) return bandsDb.last()

        for (idx in 0 until freqs.size - 1) {
            val lo = ln(freqs[idx])
            val hi = ln(freqs[idx + 1])
            if (logHz in lo..hi) {
                val span = hi - lo
                if (abs(span) < 1e-9) return bandsDb[idx]
                val t = (logHz - lo) / span
                return bandsDb[idx] + (bandsDb[idx + 1] - bandsDb[idx]) * t
            }
        }
        return 0.0
    }

    fun parseQueueTracks(array: JSONArray?): List<QueueTrackInput> {
        if (array == null) return emptyList()
        val out = ArrayList<QueueTrackInput>(array.length())
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val uri = obj.optString("uri", "").trim()
            if (uri.isEmpty()) continue
            val rawGain = obj.optDouble("replayGainLinear", 1.0)
            val gain = if (rawGain.isFinite()) rawGain.coerceIn(0.0, 4.0) else 1.0
            val rawDur = obj.optDouble("durationSec", 0.0)
            val dur = if (rawDur.isFinite() && rawDur >= 0.0) rawDur else 0.0
            val artworkPath = if (obj.isNull("artworkPath")) null else obj.optString("artworkPath", "").ifBlank { null }
            out.add(
                QueueTrackInput(
                    uri = uri,
                    trackId = obj.optLong("trackId", -1L),
                    title = obj.optString("title", "Unknown Track"),
                    artist = obj.optString("artist", "Unknown Artist"),
                    album = obj.optString("album", ""),
                    artworkPath = artworkPath,
                    durationSec = dur,
                    replayGainLinear = gain,
                )
            )
        }
        return out
    }

    fun clampVolume(volume: Double): Float {
        if (!volume.isFinite()) return 1f
        return volume.coerceIn(0.0, 1.0).toFloat()
    }

    fun clampPlaybackRate(rate: Double): Float {
        if (!rate.isFinite()) return 1f
        return rate.coerceIn(0.25, 4.0).toFloat()
    }
}
