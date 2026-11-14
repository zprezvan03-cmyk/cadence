package app.cadence.player

import android.app.PendingIntent
import android.content.Intent
import android.media.audiofx.Equalizer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * In-process playback state bus connecting CadenceMediaService (foreground service) to
 * CadenceAndroidPlugin -> WebView JS without extra Binder IPC round-trips.
 */
object CadencePlaybackBus {
    interface Listener {
        fun onPlaybackSnapshot(snapshot: JSONObject)
        fun onPlayerError(message: String)
        fun onTrackTransition(index: Int, trackId: Long)
        fun onOpenNowPlaying()
    }

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val latestSnapshot = AtomicReference<JSONObject?>(null)

    fun register(listener: Listener) {
        listeners.add(listener)
        latestSnapshot.get()?.let { listener.onPlaybackSnapshot(it) }
    }

    fun unregister(listener: Listener) {
        listeners.remove(listener)
    }

    fun getLatest(): JSONObject? = latestSnapshot.get()

    internal fun publishSnapshot(snapshot: JSONObject) {
        latestSnapshot.set(snapshot)
        for (l in listeners) l.onPlaybackSnapshot(snapshot)
    }

    internal fun publishError(message: String) {
        for (l in listeners) l.onPlayerError(message)
    }

    internal fun publishTrackTransition(index: Int, trackId: Long) {
        for (l in listeners) l.onTrackTransition(index, trackId)
    }

    fun publishOpenNowPlaying() {
        for (l in listeners) l.onOpenNowPlaying()
    }
}

@OptIn(UnstableApi::class)
class CadenceMediaService : MediaSessionService() {
    companion object {
        const val ACTION_SYNC_QUEUE = "app.cadence.player.SYNC_QUEUE"
        const val ACTION_SET_AUDIO_CONFIG = "app.cadence.player.SET_AUDIO_CONFIG"
        const val ACTION_SET_TRACK_GAIN = "app.cadence.player.SET_TRACK_GAIN"
        const val ACTION_SET_MASTER_VOLUME = "app.cadence.player.SET_MASTER_VOLUME"
        const val ACTION_SET_MUTED = "app.cadence.player.SET_MUTED"

        const val KEY_JSON = "json"
        const val KEY_START_INDEX = "startIndex"
        const val KEY_START_POSITION_MS = "startPositionMs"
        const val KEY_AUTOPLAY = "autoplay"
        const val KEY_PRESERVE_CURRENT = "preserveCurrent"
        const val KEY_GAIN = "gain"
        const val KEY_VOLUME = "volume"
        const val KEY_MUTED = "muted"
    }

    private lateinit var player: ExoPlayer
    private var mediaSession: MediaSession? = null
    private var hardwareEq: Equalizer? = null
    private var eqConfig = AndroidContracts.EqConfig(false, 0.0, List(10) { 0.0 })
    private var masterVolume: Float = 0.85f
    private var isMuted: Boolean = false
    private var trackReplayGain: Double = 1.0
    private var queueMeta: List<AndroidContracts.QueueTrackInput> = emptyList()

    private val mainHandler = Handler(Looper.getMainLooper())
    private val artworkExecutor = Executors.newSingleThreadExecutor()
    private var lastObservedIndex: Int = -1

    private val ticker = object : Runnable {
        override fun run() {
            if (!::player.isInitialized) return
            emitSnapshot()
            if (player.isPlaying) {
                mainHandler.postDelayed(this, 200L)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        player = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()

        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                mainHandler.removeCallbacks(ticker)
                emitSnapshot()
                if (isPlaying) {
                    mainHandler.postDelayed(ticker, 200L)
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                emitSnapshot()
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val idx = player.currentMediaItemIndex
                val entry = queueMeta.getOrNull(idx)
                if (entry != null) {
                    trackReplayGain = entry.replayGainLinear
                    applyOutputVolume()
                }
                if (idx != lastObservedIndex && idx >= 0) {
                    lastObservedIndex = idx
                    val trackId = entry?.trackId ?: mediaItem?.mediaMetadata?.extras?.getLong("trackId", -1L) ?: -1L
                    CadencePlaybackBus.publishTrackTransition(idx, trackId)
                }
                emitSnapshot()
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int
            ) {
                emitSnapshot()
            }

            override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
                emitSnapshot()
            }

            override fun onRepeatModeChanged(repeatMode: Int) {
                emitSnapshot()
            }

            override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) {
                emitSnapshot()
            }

            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                attachEqualizer(audioSessionId)
            }

            override fun onPlayerError(error: PlaybackException) {
                emitSnapshot()
                CadencePlaybackBus.publishError(error.message ?: "Android audio decoder error")
            }
        })

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("openNowPlaying", true)
        }
        val sessionActivity = PendingIntent.getActivity(
            this,
            0,
            launchIntent ?: Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        mediaSession = MediaSession.Builder(this, player)
            .setSessionActivity(sessionActivity)
            .setCallback(object : MediaSession.Callback {
                override fun onConnect(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo
                ): MediaSession.ConnectionResult {
                    val sessionCommands = SessionCommands.Builder()
                        .add(SessionCommand(ACTION_SYNC_QUEUE, Bundle.EMPTY))
                        .add(SessionCommand(ACTION_SET_AUDIO_CONFIG, Bundle.EMPTY))
                        .add(SessionCommand(ACTION_SET_TRACK_GAIN, Bundle.EMPTY))
                        .add(SessionCommand(ACTION_SET_MASTER_VOLUME, Bundle.EMPTY))
                        .add(SessionCommand(ACTION_SET_MUTED, Bundle.EMPTY))
                        .build()
                    return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                        .setAvailableSessionCommands(sessionCommands)
                        .build()
                }

                override fun onCustomCommand(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    customCommand: SessionCommand,
                    args: Bundle
                ): ListenableFuture<SessionResult> {
                    when (customCommand.customAction) {
                        ACTION_SYNC_QUEUE -> {
                            val raw = args.getString(KEY_JSON)
                            val arr = raw?.let { JSONArray(it) }
                            val items = AndroidContracts.parseQueueTracks(arr)
                            val startIndex = args.getInt(KEY_START_INDEX, 0)
                            val startPosMs = args.getLong(KEY_START_POSITION_MS, 0L).coerceAtLeast(0L)
                            val autoplay = args.getBoolean(KEY_AUTOPLAY, true)
                            val preserveCurrent = args.getBoolean(KEY_PRESERVE_CURRENT, false)
                            applyQueue(items, startIndex, startPosMs, autoplay, preserveCurrent)
                        }
                        ACTION_SET_AUDIO_CONFIG -> {
                            val raw = args.getString(KEY_JSON)
                            val json = raw?.let { JSONObject(it) }
                            eqConfig = AndroidContracts.parseEqConfig(json?.optJSONObject("equalizer"))
                            applyEqualizerToHardware()
                        }
                        ACTION_SET_TRACK_GAIN -> {
                            val gain = args.getDouble(KEY_GAIN, 1.0)
                            trackReplayGain = if (gain.isFinite()) gain.coerceIn(0.0, 4.0) else 1.0
                            applyOutputVolume()
                        }
                        ACTION_SET_MASTER_VOLUME -> {
                            masterVolume = AndroidContracts.clampVolume(args.getDouble(KEY_VOLUME, 0.85))
                            applyOutputVolume()
                            emitSnapshot()
                        }
                        ACTION_SET_MUTED -> {
                            isMuted = args.getBoolean(KEY_MUTED, false)
                            applyOutputVolume()
                            emitSnapshot()
                        }
                    }
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
            })
            .build()

        attachEqualizer(player.audioSessionId)
        emitSnapshot()
    }

    private fun applyQueue(
        items: List<AndroidContracts.QueueTrackInput>,
        startIndex: Int,
        startPosMs: Long,
        autoplay: Boolean,
        preserveCurrent: Boolean = false,
    ) {
        queueMeta = items
        if (items.isEmpty()) {
            lastObservedIndex = -1
            player.stop()
            player.clearMediaItems()
            emitSnapshot()
            return
        }

        val clampedIndex = startIndex.coerceIn(0, items.lastIndex)
        lastObservedIndex = clampedIndex
        trackReplayGain = items[clampedIndex].replayGainLinear
        applyOutputVolume()

        val mediaItems = items.map { track ->
            val extras = Bundle().apply {
                putLong("trackId", track.trackId)
                putDouble("replayGainLinear", track.replayGainLinear)
            }
            val meta = MediaMetadata.Builder()
                .setTitle(track.title)
                .setArtist(track.artist)
                .setAlbumTitle(track.album)
                .setExtras(extras)
                .build()

            val uri = if (track.uri.startsWith("content://") || track.uri.startsWith("http")) {
                Uri.parse(track.uri)
            } else {
                Uri.fromFile(File(track.uri))
            }

            MediaItem.Builder()
                .setMediaId(track.trackId.toString())
                .setUri(uri)
                .setMediaMetadata(meta)
                .build()
        }

        val currentIdx = player.currentMediaItemIndex
        val currentId = if (currentIdx in 0 until player.mediaItemCount) {
            player.getMediaItemAt(currentIdx).mediaId
        } else {
            null
        }
        val canPreserve =
            preserveCurrent &&
                currentId != null &&
                currentId == items[clampedIndex].trackId.toString() &&
                player.playbackState != Player.STATE_IDLE

        if (canPreserve) {
            if (currentIdx > 0) {
                player.removeMediaItems(0, currentIdx)
            }
            if (player.mediaItemCount > 1) {
                player.removeMediaItems(1, player.mediaItemCount)
            }
            if (clampedIndex > 0) {
                player.addMediaItems(0, mediaItems.subList(0, clampedIndex))
            }
            if (clampedIndex + 1 < mediaItems.size) {
                player.addMediaItems(clampedIndex + 1, mediaItems.subList(clampedIndex + 1, mediaItems.size))
            }
        } else {
            player.setMediaItems(mediaItems, clampedIndex, startPosMs)
            player.prepare()
            player.playWhenReady = autoplay
        }
        emitSnapshot()

        // Load compressed cover art bytes off the UI thread so lockscreen / Quick Settings show album art.
        items.forEachIndexed { idx, track ->
            val artPath = track.artworkPath ?: return@forEachIndexed
            val file = File(artPath)
            if (!file.isFile) return@forEachIndexed
            artworkExecutor.execute {
                try {
                    val bytes = file.readBytes()
                    if (bytes.isEmpty() || bytes.size > 2 * 1024 * 1024) return@execute
                    mainHandler.post {
                        if (!::player.isInitialized || idx >= player.mediaItemCount) return@post
                        val current = player.getMediaItemAt(idx)
                        if (current.mediaId != track.trackId.toString()) return@post
                        val updatedMeta = current.mediaMetadata.buildUpon()
                            .setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                            .build()
                        player.replaceMediaItem(idx, current.buildUpon().setMediaMetadata(updatedMeta).build())
                    }
                } catch (_: Exception) {
                    // Lockscreen artwork is best-effort.
                }
            }
        }
    }

    private fun attachEqualizer(sessionId: Int) {
        if (sessionId == C.AUDIO_SESSION_ID_UNSET || sessionId == 0) return
        try {
            hardwareEq?.release()
            hardwareEq = Equalizer(0, sessionId)
            applyEqualizerToHardware()
        } catch (_: Exception) {
            hardwareEq = null
        }
    }

    private fun applyEqualizerToHardware() {
        val eq = hardwareEq ?: return
        try {
            val numBands = eq.numberOfBands.toInt()
            if (numBands <= 0) return
            val range = eq.bandLevelRange
            val minMb = range[0]
            val maxMb = range[1]
            val centers = IntArray(numBands) { b -> eq.getCenterFreq(b.toShort()) }
            val mapped = AndroidContracts.mapEqToDeviceMillibels(eqConfig, centers, minMb, maxMb)
            eq.enabled = eqConfig.enabled
            for (b in 0 until numBands) {
                eq.setBandLevel(b.toShort(), mapped[b])
            }
        } catch (_: Exception) {
            // Some OEM DSPs reject updates while idle.
        }
    }

    private fun applyOutputVolume() {
        if (!::player.isInitialized) return
        if (isMuted) {
            player.volume = 0f
            return
        }
        val combined = (masterVolume.toDouble() * trackReplayGain).coerceIn(0.0, 1.0)
        player.volume = combined.toFloat()
    }

    private fun emitSnapshot() {
        if (!::player.isInitialized) return
        val idx = player.currentMediaItemIndex
        val entry = queueMeta.getOrNull(idx)
        val rawDur = player.duration
        val durationSec = if (rawDur != C.TIME_UNSET && rawDur > 0) rawDur.toDouble() / 1000.0 else (entry?.durationSec ?: 0.0)
        val posSec = player.currentPosition.coerceAtLeast(0L).toDouble() / 1000.0
        val bufSec = player.bufferedPosition.coerceAtLeast(0L).toDouble() / 1000.0
        val repeat = when (player.repeatMode) {
            Player.REPEAT_MODE_ONE -> "one"
            Player.REPEAT_MODE_ALL -> "all"
            else -> "off"
        }
        val ended = player.playbackState == Player.STATE_ENDED

        val snap = JSONObject().apply {
            put("index", idx)
            put("trackId", entry?.trackId ?: -1L)
            put("position", posSec)
            put("duration", durationSec)
            put("buffered", bufSec)
            put("playing", player.isPlaying)
            put("buffering", player.playbackState == Player.STATE_BUFFERING)
            put("ended", ended)
            put("repeat", repeat)
            put("shuffle", player.shuffleModeEnabled)
            put("rate", player.playbackParameters.speed.toDouble())
            put("volume", masterVolume.toDouble())
            put("muted", isMuted)
            put("sampledAt", System.currentTimeMillis())
        }
        CadencePlaybackBus.publishSnapshot(snap)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        val sessionPlayer = mediaSession?.player
        if (sessionPlayer == null || !sessionPlayer.playWhenReady || sessionPlayer.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(ticker)
        artworkExecutor.shutdownNow()
        try {
            hardwareEq?.release()
        } catch (_: Exception) {
        }
        hardwareEq = null
        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }
}
