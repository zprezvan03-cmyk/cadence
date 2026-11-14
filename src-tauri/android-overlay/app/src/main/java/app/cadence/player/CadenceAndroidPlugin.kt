package app.cadence.player

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

@TauriPlugin
class CadenceAndroidPlugin(private val activity: Activity) : Plugin(activity) {
    private val ioExecutor = Executors.newCachedThreadPool()
    private val pendingExports = ConcurrentHashMap<Long, String>()

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    private var controllerFuture: ListenableFuture<MediaController>? = null

    @Volatile
    private var controller: MediaController? = null

    private val busListener = object : CadencePlaybackBus.Listener {
        override fun onPlaybackSnapshot(snapshot: JSONObject) {
            dispatchToWebView("playback", snapshot)
        }

        override fun onPlayerError(message: String) {
            dispatchToWebView("error", JSONObject().apply { put("message", message) })
        }

        override fun onTrackTransition(index: Int, trackId: Long) {
            dispatchToWebView(
                "trackTransition",
                JSONObject().apply {
                    put("index", index)
                    put("trackId", trackId)
                }
            )
        }

        override fun onOpenNowPlaying() {
            dispatchToWebView("openNowPlaying", JSONObject())
        }
    }

    override fun load(webView: WebView) {
        webViewRef = WeakReference(webView)
        CadencePlaybackBus.register(busListener)
    }

    override fun onNewIntent(intent: Intent) {
        if (intent.getBooleanExtra("openNowPlaying", false)) {
            CadencePlaybackBus.publishOpenNowPlaying()
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        CadencePlaybackBus.unregister(busListener)
        controllerFuture?.let {
            MediaController.releaseFuture(it)
            controllerFuture = null
        }
        controller = null
        ioExecutor.shutdownNow()
        super.onDestroy(activity)
    }

    private fun dispatchToWebView(event: String, payload: JSONObject) {
        val wv = webViewRef?.get() ?: return
        val envelope = JSONObject().apply {
            put("event", event)
            put("payload", payload)
        }
        val script = "window.__cadenceAndroidDispatch && window.__cadenceAndroidDispatch($envelope);"
        wv.post {
            wv.evaluateJavascript(script, null)
        }
    }

    private fun withMediaController(onReady: (MediaController) -> Unit, onError: (String) -> Unit) {
        activity.runOnUiThread {
            val existing = controller
            if (existing != null && existing.isConnected) {
                onReady(existing)
                return@runOnUiThread
            }
            val future = controllerFuture ?: run {
                val token = SessionToken(activity, ComponentName(activity, CadenceMediaService::class.java))
                MediaController.Builder(activity, token).buildAsync().also {
                    controllerFuture = it
                }
            }
            future.addListener(
                {
                    try {
                        val mc = future.get()
                        controller = mc
                        onReady(mc)
                    } catch (err: Exception) {
                        controllerFuture = null
                        onError(err.message ?: "Failed to connect Media3 playback service")
                    }
                },
                ContextCompat.getMainExecutor(activity)
            )
        }
    }

    @Command
    fun requestAudioPermissions(invoke: Invoke) {
        val status = CadenceStorageHelper.checkPermissions(activity)
        if (status.missingPermissions.isEmpty()) {
            invoke.resolve(JSObject(status.toJson().toString()))
            return
        }
        val pluginHandle = handle
        if (pluginHandle == null) {
            invoke.resolve(JSObject(status.toJson().toString()))
            return
        }
        pluginHandle.requestPermissions(
            invoke,
            status.missingPermissions,
            "onAudioPermissionsCallback"
        )
    }

    @PermissionCallback
    fun onAudioPermissionsCallback(invoke: Invoke) {
        val updated = CadenceStorageHelper.checkPermissions(activity)
        invoke.resolve(JSObject(updated.toJson().toString()))
    }

    @Command
    fun pickMusicFolder(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            )
        }
        startActivityForResult(invoke, intent, "onMusicFolderPicked")
    }

    @ActivityCallback
    fun onMusicFolderPicked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolve(JSObject().apply { put("path", JSONObject.NULL) })
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            invoke.resolve(JSObject().apply { put("path", JSONObject.NULL) })
            return
        }
        CadenceStorageHelper.takePersistableTreePermission(activity, uri)
        invoke.resolve(JSObject().apply { put("path", uri.toString()) })
    }

    @Command
    fun pickLyricsFile(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/*", "application/ttml+xml", "application/xml", "application/x-subrip"))
        }
        startActivityForResult(invoke, intent, "onLyricsFilePicked")
    }

    @ActivityCallback
    fun onLyricsFilePicked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolve()
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            invoke.resolve()
            return
        }
        ioExecutor.execute {
            val text = CadenceStorageHelper.readSafText(activity, uri.toString())
            if (text == null) {
                invoke.reject("Could not read selected lyrics file")
            } else {
                invoke.resolve(
                    JSObject().apply {
                        put("path", uri.toString())
                        put("text", text)
                    }
                )
            }
        }
    }

    @Command
    fun exportTextFile(invoke: Invoke) {
        val args = invoke.getArgs()
        val fileName = args.getString("fileName", "cadence-export.txt")
        val content = args.getString("content", "")
        pendingExports[invoke.id] = content
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "text/plain"
            putExtra(Intent.EXTRA_TITLE, fileName)
        }
        startActivityForResult(invoke, intent, "onExportFilePicked")
    }

    @ActivityCallback
    fun onExportFilePicked(invoke: Invoke, result: ActivityResult) {
        val content = pendingExports.remove(invoke.id)
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolve(JSObject().apply { put("path", JSONObject.NULL) })
            return
        }
        val uri = result.data?.data
        if (uri == null || content == null) {
            invoke.resolve(JSObject().apply { put("path", JSONObject.NULL) })
            return
        }
        ioExecutor.execute {
            try {
                activity.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                    out.write(content.toByteArray(Charsets.UTF_8))
                } ?: throw IllegalStateException("Cannot open export target")
                invoke.resolve(JSObject().apply { put("path", uri.toString()) })
            } catch (err: Exception) {
                invoke.reject(err.message ?: "Failed to export file")
            }
        }
    }

    @Command
    fun walkFolders(invoke: Invoke) {
        val args = invoke.getArgs()
        val arr = args.optJSONArray("folders") ?: JSONArray()
        val folders = (0 until arr.length()).mapNotNull { arr.optString(it, null) }
        ioExecutor.execute {
            try {
                val res = CadenceStorageHelper.walkFolders(activity, folders)
                invoke.resolve(JSObject(res.toString()))
            } catch (err: Exception) {
                invoke.reject(err.message ?: "Folder walk failed")
            }
        }
    }

    @Command
    fun statContentUri(invoke: Invoke) {
        val uri = invoke.getArgs().getString("uri")
        ioExecutor.execute {
            try {
                val stat = CadenceStorageHelper.statContentUri(activity, uri)
                invoke.resolve(JSObject(stat.toString()))
            } catch (err: Exception) {
                invoke.reject(err.message ?: "Failed to stat URI")
            }
        }
    }

    @Command
    fun readContentChunk(invoke: Invoke) {
        val args = invoke.getArgs()
        val uri = args.getString("uri")
        val offset = args.optLong("offset", 0L).coerceAtLeast(0L)
        val length = args.optInt("length", 65536).coerceAtLeast(0)
        ioExecutor.execute {
            try {
                val chunk = CadenceStorageHelper.readContentChunk(activity, uri, offset, length)
                invoke.resolve(JSObject(chunk.toString()))
            } catch (err: Exception) {
                invoke.reject(err.message ?: "Failed to read chunk")
            }
        }
    }

    @Command
    fun copyContentToFile(invoke: Invoke) {
        val args = invoke.getArgs()
        val uri = args.getString("uri")
        val destPath = args.getString("destPath")
        ioExecutor.execute {
            try {
                CadenceStorageHelper.copyContentToFile(activity, uri, destPath)
                invoke.resolve(JSObject().apply { put("ok", true) })
            } catch (err: Exception) {
                invoke.reject(err.message ?: "Failed to copy content URI")
            }
        }
    }

    @Command
    fun listDirectory(invoke: Invoke) {
        val uri = invoke.getArgs().getString("uri")
        ioExecutor.execute {
            try {
                val names = CadenceStorageHelper.listSafDirectory(activity, uri)
                invoke.resolve(JSObject().apply { put("names", JSONArray(names)) })
            } catch (err: Exception) {
                invoke.resolve(JSObject().apply { put("names", JSONArray()) })
            }
        }
    }

    @Command
    fun readSidecarText(invoke: Invoke) {
        val uri = invoke.getArgs().getString("uri")
        ioExecutor.execute {
            val text = CadenceStorageHelper.readSafText(activity, uri)
            invoke.resolve(JSObject().apply { put("text", text ?: JSONObject.NULL) })
        }
    }

    @Command
    fun writeSidecar(invoke: Invoke) {
        val args = invoke.getArgs()
        val audioUri = args.getString("audioUri")
        val text = args.getString("text")
        val ext = args.getString("ext", "lrc")
        ioExecutor.execute {
            try {
                val written = CadenceStorageHelper.writeSafSidecar(activity, audioUri, text, ext)
                invoke.resolve(JSObject().apply { put("path", written) })
            } catch (err: Exception) {
                invoke.reject(err.message ?: "Failed to write sidecar file")
            }
        }
    }

    @Command
    fun deleteContentUris(invoke: Invoke) {
        val arr = invoke.getArgs().optJSONArray("uris") ?: JSONArray()
        val uris = (0 until arr.length()).mapNotNull { arr.optString(it, null) }
        ioExecutor.execute {
            val outcomes = CadenceStorageHelper.deleteContentUris(activity, uris)
            val list = (0 until outcomes.length()).map { idx ->
                val obj = outcomes.getJSONObject(idx)
                mapOf(
                    "path" to obj.getString("path"),
                    "deleted" to obj.getBoolean("deleted"),
                    "error" to if (obj.isNull("error")) null else obj.getString("error")
                )
            }
            invoke.resolveObject(list)
        }
    }

    @Command
    fun audioAction(invoke: Invoke) {
        val args = invoke.getArgs()
        val action = args.getString("action")
        val payload = args.optJSONObject("payload") ?: JSONObject()

        if (action == "setSystemBars") {
            val light = payload.optBoolean("light", false)
            activity.runOnUiThread {
                val ctrl = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
                ctrl.isAppearanceLightStatusBars = light
                ctrl.isAppearanceLightNavigationBars = light
            }
            invoke.resolve(JSObject().apply { put("ok", true) })
            return
        }

        if (action == "getPlaybackState") {
            val latest = CadencePlaybackBus.getLatest() ?: JSONObject().apply {
                put("index", -1)
                put("trackId", -1)
                put("position", 0.0)
                put("duration", 0.0)
                put("buffered", 0.0)
                put("playing", false)
                put("buffering", false)
                put("ended", false)
                put("repeat", "off")
                put("shuffle", false)
                put("rate", 1.0)
                put("volume", 0.85)
                put("muted", false)
            }
            invoke.resolve(JSObject(latest.toString()))
            return
        }

        withMediaController(
            onReady = { mc ->
                try {
                    when (action) {
                        "syncQueue" -> {
                            val items = payload.optJSONArray("items") ?: JSONArray()
                            val startIndex = payload.optInt("startIndex", 0)
                            val startPosSec = payload.optDouble("startPositionSec", 0.0).coerceAtLeast(0.0)
                            val autoplay = payload.optBoolean("autoplay", true)
                            val preserveCurrent = payload.optBoolean("preserveCurrent", false)
                            val bundle = Bundle().apply {
                                putString(CadenceMediaService.KEY_JSON, items.toString())
                                putInt(CadenceMediaService.KEY_START_INDEX, startIndex)
                                putLong(CadenceMediaService.KEY_START_POSITION_MS, (startPosSec * 1000.0).toLong())
                                putBoolean(CadenceMediaService.KEY_AUTOPLAY, autoplay)
                                putBoolean(CadenceMediaService.KEY_PRESERVE_CURRENT, preserveCurrent)
                            }
                            mc.sendCustomCommand(
                                SessionCommand(CadenceMediaService.ACTION_SYNC_QUEUE, Bundle.EMPTY),
                                bundle
                            )
                        }
                        "loadTrack" -> {
                            val track = payload.optJSONObject("track")
                            val items = JSONArray().apply { if (track != null) put(track) }
                            val autoplay = payload.optBoolean("autoplay", true)
                            val startPosSec = payload.optDouble("startPositionSec", 0.0).coerceAtLeast(0.0)
                            val bundle = Bundle().apply {
                                putString(CadenceMediaService.KEY_JSON, items.toString())
                                putInt(CadenceMediaService.KEY_START_INDEX, 0)
                                putLong(CadenceMediaService.KEY_START_POSITION_MS, (startPosSec * 1000.0).toLong())
                                putBoolean(CadenceMediaService.KEY_AUTOPLAY, autoplay)
                            }
                            mc.sendCustomCommand(
                                SessionCommand(CadenceMediaService.ACTION_SYNC_QUEUE, Bundle.EMPTY),
                                bundle
                            )
                        }
                        "play" -> mc.play()
                        "pause" -> mc.pause()
                        "toggle" -> if (mc.isPlaying) mc.pause() else mc.play()
                        "stop" -> mc.stop()
                        "seek" -> {
                            val posSec = payload.optDouble("position", 0.0).coerceAtLeast(0.0)
                            mc.seekTo((posSec * 1000.0).toLong())
                        }
                        "next" -> if (mc.hasNextMediaItem()) mc.seekToNextMediaItem()
                        "previous" -> mc.seekToPrevious()
                        "setRate" -> {
                            val rate = AndroidContracts.clampPlaybackRate(payload.optDouble("rate", 1.0))
                            mc.setPlaybackSpeed(rate)
                        }
                        "setRepeat" -> {
                            mc.repeatMode = when (payload.optString("repeat", "off")) {
                                "one" -> Player.REPEAT_MODE_ONE
                                "all" -> Player.REPEAT_MODE_ALL
                                else -> Player.REPEAT_MODE_OFF
                            }
                        }
                        "setShuffle" -> {
                            mc.shuffleModeEnabled = payload.optBoolean("shuffle", false)
                        }
                        "setVolume" -> {
                            val bundle = Bundle().apply {
                                putDouble(CadenceMediaService.KEY_VOLUME, payload.optDouble("volume", 0.85))
                            }
                            mc.sendCustomCommand(
                                SessionCommand(CadenceMediaService.ACTION_SET_MASTER_VOLUME, Bundle.EMPTY),
                                bundle
                            )
                        }
                        "setMuted" -> {
                            val bundle = Bundle().apply {
                                putBoolean(CadenceMediaService.KEY_MUTED, payload.optBoolean("muted", false))
                            }
                            mc.sendCustomCommand(
                                SessionCommand(CadenceMediaService.ACTION_SET_MUTED, Bundle.EMPTY),
                                bundle
                            )
                        }
                        "setAudioConfig", "setEqualizer" -> {
                            val bundle = Bundle().apply {
                                putString(CadenceMediaService.KEY_JSON, payload.toString())
                            }
                            mc.sendCustomCommand(
                                SessionCommand(CadenceMediaService.ACTION_SET_AUDIO_CONFIG, Bundle.EMPTY),
                                bundle
                            )
                        }
                        "setTrackGain" -> {
                            val bundle = Bundle().apply {
                                putDouble(CadenceMediaService.KEY_GAIN, payload.optDouble("gain", 1.0))
                            }
                            mc.sendCustomCommand(
                                SessionCommand(CadenceMediaService.ACTION_SET_TRACK_GAIN, Bundle.EMPTY),
                                bundle
                            )
                        }
                    }
                    invoke.resolve(JSObject().apply { put("ok", true) })
                } catch (err: Exception) {
                    invoke.reject(err.message ?: "Media3 command failed")
                }
            },
            onError = { message ->
                invoke.reject(message)
            }
        )
    }

    @Command
    fun getSystemInfo(invoke: Invoke) {
        val perms = CadenceStorageHelper.checkPermissions(activity)
        val persisted = CadenceStorageHelper.persistedTreeUris(activity)
        val obj = JSONObject().apply {
            put("sdkInt", Build.VERSION.SDK_INT)
            put("release", Build.VERSION.RELEASE)
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("audioGranted", perms.audioGranted)
            put("notificationsGranted", perms.notificationsGranted)
            put("persistedTreeUris", JSONArray(persisted))
        }
        invoke.resolve(JSObject(obj.toString()))
    }
}
