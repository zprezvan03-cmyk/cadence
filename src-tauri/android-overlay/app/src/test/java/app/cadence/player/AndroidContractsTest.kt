package app.cadence.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidContractsTest {
    @Test
    fun detectsAudioAndLyricsExtensions() {
        assertTrue(AndroidContracts.isAudioFileName("01 - Midnight.FLAC"))
        assertTrue(AndroidContracts.isAudioFileName("song.m4a"))
        assertTrue(AndroidContracts.isAudioFileName("mix.opus"))
        assertFalse(AndroidContracts.isAudioFileName("cover.mp4.jpg"))
        assertFalse(AndroidContracts.isAudioFileName("notes.lrc"))
        assertTrue(AndroidContracts.isLyricsFileName("Track.TTML"))
        assertTrue(AndroidContracts.isLyricsFileName("Track.lrc"))
    }

    @Test
    fun disabledEqualizerZerosAllDeviceBands() {
        val cfg = AndroidContracts.EqConfig(
            enabled = false,
            preampDb = 6.0,
            bandsDb = List(10) { 8.0 },
        )
        val deviceCenters = intArrayOf(60_000, 230_000, 910_000, 3_600_000, 14_000_000)
        val mapped = AndroidContracts.mapEqToDeviceMillibels(cfg, deviceCenters, -1500, 1500)
        assertArrayEquals(shortArrayOf(0, 0, 0, 0, 0), mapped)
    }

    @Test
    fun mapsTenBandEqToFiveBandAndroidHardwareAndClamps() {
        val cfg = AndroidContracts.EqConfig(
            enabled = true,
            preampDb = 3.0,
            bandsDb = listOf(6.0, 6.0, 2.0, 0.0, 0.0, 0.0, 0.0, 4.0, 8.0, 12.0),
        )
        val deviceCenters = intArrayOf(60_000, 230_000, 910_000, 3_600_000, 14_000_000)
        val mapped = AndroidContracts.mapEqToDeviceMillibels(cfg, deviceCenters, -1500, 1500)
        assertEquals(5, mapped.size)
        // Bass band (~60Hz) gets ~6dB + 3dB preamp = ~900 mB
        assertTrue(mapped[0].toInt() in 850..950)
        // High band (~14kHz) gets clamped to hardware max 1500 mB
        assertEquals(1500.toShort(), mapped[4])
    }

    @Test
    fun parsesQueueTracksSafelyAndClampsGains() {
        val json = JSONArray().apply {
            put(
                JSONObject().apply {
                    put("uri", "content://media/external/audio/media/42")
                    put("trackId", 42)
                    put("title", "Song A")
                    put("artist", "Artist")
                    put("album", "Album")
                    put("replayGainLinear", 99.0)
                    put("durationSec", 215.5)
                }
            )
            put(JSONObject().apply { put("uri", "") })
        }
        val tracks = AndroidContracts.parseQueueTracks(json)
        assertEquals(1, tracks.size)
        assertEquals(42L, tracks[0].trackId)
        assertEquals(4.0, tracks[0].replayGainLinear, 0.0001)
    }

    @Test
    fun clampsVolumeAndRateBounds() {
        assertEquals(0f, AndroidContracts.clampVolume(-0.5), 0.0001f)
        assertEquals(1f, AndroidContracts.clampVolume(Double.NaN), 0.0001f)
        assertEquals(0.25f, AndroidContracts.clampPlaybackRate(0.05), 0.0001f)
        assertEquals(4f, AndroidContracts.clampPlaybackRate(8.0), 0.0001f)
    }
}
