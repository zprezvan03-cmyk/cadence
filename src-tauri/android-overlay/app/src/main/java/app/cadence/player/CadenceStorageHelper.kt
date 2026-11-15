package app.cadence.player

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.documentfile.provider.DocumentFile
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

object CadenceStorageHelper {
    private const val MAX_SCAN_DEPTH = 32
    private const val MAX_SIDECAR_BYTES = 2L * 1024L * 1024L

    private val SAF_CHILD_PROJECTION = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )

    data class PermissionStatus(
        val audioGranted: Boolean,
        val notificationsGranted: Boolean,
        val sdkInt: Int,
        val missingPermissions: Array<String>,
    ) {
        fun toJsObject(): JSObject = JSObject().apply {
            put("audioGranted", audioGranted)
            put("notificationsGranted", notificationsGranted)
            put("sdkInt", sdkInt)
        }
    }

    fun checkPermissions(context: Context, includeNotifications: Boolean = true): PermissionStatus {
        val sdk = Build.VERSION.SDK_INT
        val missing = mutableListOf<String>()

        val audioPerm = if (sdk >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_AUDIO
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        val audioGranted =
            ContextCompat.checkSelfPermission(context, audioPerm) == PackageManager.PERMISSION_GRANTED
        if (!audioGranted) missing.add(audioPerm)

        val notificationsGranted = if (sdk >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (includeNotifications && !granted) missing.add(Manifest.permission.POST_NOTIFICATIONS)
            granted
        } else {
            true
        }

        return PermissionStatus(
            audioGranted = audioGranted,
            notificationsGranted = notificationsGranted,
            sdkInt = sdk,
            missingPermissions = missing.toTypedArray(),
        )
    }

    fun takePersistableTreePermission(context: Context, uri: Uri) {
        try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (_: SecurityException) {
            // Best effort if provider does not support persistable permissions.
        }
        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) {
            // Read-only grant is still sufficient for scanning and playback.
        }
    }

    fun persistedTreeUris(context: Context): List<String> =
        context.contentResolver.persistedUriPermissions
            .filter { it.isReadPermission }
            .map { it.uri.toString() }

    fun walkFolders(
        context: Context,
        folders: List<String>,
        onProgress: ((Int) -> Unit)? = null,
    ): JSObject {
        val filesOut = JSArray()
        val errorsOut = JSArray()
        val seen = HashSet<String>()
        var totalSeen = 0

        val reportSeen = { count: Int ->
            totalSeen = count
            onProgress?.invoke(totalSeen)
        }

        for (folder in folders) {
            try {
                when {
                    folder == "mediastore://audio" -> {
                        val entries = scanMediaStore(context) { deltaCount ->
                            reportSeen(filesOut.length() + deltaCount)
                        }
                        for (entry in entries) {
                            if (seen.add(entry.path)) filesOut.put(entry.toJsObject())
                        }
                    }
                    folder.startsWith("content://") -> {
                        val treeUri = Uri.parse(folder)
                        val rootDocId = try {
                            DocumentsContract.getTreeDocumentId(treeUri)
                        } catch (_: Exception) {
                            null
                        }
                        if (rootDocId.isNullOrBlank()) {
                            errorsOut.put(errorJsObject(folder, "Cannot access selected folder (invalid folder URI)"))
                        } else {
                            val entries = ArrayList<AndroidContracts.WalkedAudioEntry>()
                            val accessible = walkDocumentTreeCursor(
                                context = context,
                                treeUri = treeUri,
                                rootDocId = rootDocId,
                                out = entries,
                                onProgress = { deltaCount -> reportSeen(filesOut.length() + deltaCount) },
                            )
                            if (!accessible && entries.isEmpty()) {
                                errorsOut.put(errorJsObject(folder, "Cannot access selected folder (permission revoked or unavailable)"))
                            }
                            for (entry in entries) {
                                if (seen.add(entry.path)) filesOut.put(entry.toJsObject())
                            }
                        }
                    }
                    else -> {
                        val dir = File(folder)
                        if (!dir.exists() || !dir.isDirectory) {
                            errorsOut.put(errorJsObject(folder, "Not a directory"))
                        } else {
                            val entries = ArrayList<AndroidContracts.WalkedAudioEntry>()
                            walkPosixDir(dir, 0, entries) { deltaCount ->
                                reportSeen(filesOut.length() + deltaCount)
                            }
                            for (entry in entries) {
                                if (seen.add(entry.path)) filesOut.put(entry.toJsObject())
                            }
                        }
                    }
                }
            } catch (err: Exception) {
                errorsOut.put(errorJsObject(folder, err.message ?: "Scan error"))
            }
        }

        onProgress?.invoke(filesOut.length())
        return JSObject().apply {
            put("files", filesOut)
            put("errors", errorsOut)
        }
    }

    private fun scanMediaStore(
        context: Context,
        onProgress: ((Int) -> Unit)? = null,
    ): List<AndroidContracts.WalkedAudioEntry> {
        val perm = checkPermissions(context)
        if (!perm.audioGranted) {
            throw SecurityException("Audio library permission is not granted")
        }

        val out = ArrayList<AndroidContracts.WalkedAudioEntry>()
        val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }

        val projCols = mutableListOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.IS_MUSIC,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.TRACK,
            MediaStore.Audio.Media.YEAR,
            MediaStore.Audio.Media.IS_RINGTONE,
            MediaStore.Audio.Media.IS_ALARM,
            MediaStore.Audio.Media.IS_NOTIFICATION,
            MediaStore.Audio.Media.IS_PODCAST,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            projCols.add(MediaStore.Audio.Media.RELATIVE_PATH)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            projCols.add(MediaStore.Audio.Media.ALBUM_ARTIST)
            projCols.add(MediaStore.MediaColumns.IS_TRASHED)
            projCols.add(MediaStore.MediaColumns.IS_PENDING)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            projCols.add(MediaStore.Audio.Media.IS_RECORDING)
        }

        val selection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            "${MediaStore.Audio.Media.SIZE} > 0 AND ${MediaStore.MediaColumns.IS_TRASHED} = 0 AND ${MediaStore.MediaColumns.IS_PENDING} = 0"
        } else {
            "${MediaStore.Audio.Media.SIZE} > 0"
        }

        context.contentResolver.query(
            uri,
            projCols.toTypedArray(),
            selection,
            null,
            "${MediaStore.Audio.Media.DATE_MODIFIED} DESC"
        )?.use { cursor ->
            val colId = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val colName = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val colSize = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
            val colMtime = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
            val colData = cursor.getColumnIndex(MediaStore.Audio.Media.DATA)
            val colIsMusic = cursor.getColumnIndex(MediaStore.Audio.Media.IS_MUSIC)
            val colDuration = cursor.getColumnIndex(MediaStore.Audio.Media.DURATION)
            val colMime = cursor.getColumnIndex(MediaStore.Audio.Media.MIME_TYPE)
            val colTitle = cursor.getColumnIndex(MediaStore.Audio.Media.TITLE)
            val colArtist = cursor.getColumnIndex(MediaStore.Audio.Media.ARTIST)
            val colAlbum = cursor.getColumnIndex(MediaStore.Audio.Media.ALBUM)
            val colAlbumArtist = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                cursor.getColumnIndex(MediaStore.Audio.Media.ALBUM_ARTIST)
            } else {
                -1
            }
            val colTrack = cursor.getColumnIndex(MediaStore.Audio.Media.TRACK)
            val colYear = cursor.getColumnIndex(MediaStore.Audio.Media.YEAR)
            val colRelativePath = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                cursor.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
            } else {
                -1
            }
            val colIsRingtone = cursor.getColumnIndex(MediaStore.Audio.Media.IS_RINGTONE)
            val colIsAlarm = cursor.getColumnIndex(MediaStore.Audio.Media.IS_ALARM)
            val colIsNotification = cursor.getColumnIndex(MediaStore.Audio.Media.IS_NOTIFICATION)
            val colIsRecording = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                cursor.getColumnIndex(MediaStore.Audio.Media.IS_RECORDING)
            } else {
                -1
            }

            val siblingCache = HashMap<String, Map<String, File>>()

            while (cursor.moveToNext()) {
                val id = cursor.getLong(colId)
                val name = cursor.getString(colName) ?: ""
                val mimeType = if (colMime >= 0) cursor.getString(colMime) else null
                val isMusic = if (colIsMusic >= 0) cursor.getInt(colIsMusic) != 0 else true
                val isRingtone = colIsRingtone >= 0 && cursor.getInt(colIsRingtone) != 0
                val isAlarm = colIsAlarm >= 0 && cursor.getInt(colIsAlarm) != 0
                val isNotification = colIsNotification >= 0 && cursor.getInt(colIsNotification) != 0
                val isRecording = colIsRecording >= 0 && cursor.getInt(colIsRecording) != 0
                val durationMs = if (colDuration >= 0) cursor.getLong(colDuration) else 0L

                if (!isMusic && (isRingtone || isAlarm || isNotification || isRecording)) continue

                val dataPath = if (colData >= 0) cursor.getString(colData) else null
                val relativePath = if (colRelativePath >= 0) cursor.getString(colRelativePath) else null
                val fileName = if (name.isNotBlank()) name else dataPath.orEmpty()
                if (!AndroidContracts.isAudioEntry(fileName, mimeType)) continue

                // Skip tiny notification/UI sound clips and voice-note/system directories unless explicitly music.
                if (!isMusic && durationMs in 1..4999) continue
                if (AndroidContracts.shouldFilterMediaStorePath(dataPath ?: relativePath, isMusic)) continue

                val contentUri = ContentUris.withAppendedId(uri, id).toString()
                val directFile = dataPath?.let { File(it) }?.takeIf { it.isFile && it.canRead() }
                val resolvedPath = directFile?.absolutePath ?: contentUri
                val size = cursor.getLong(colSize).coerceAtLeast(0L)
                val mtimeMs = cursor.getLong(colMtime).toDouble() * 1000.0

                var hasSidecarLyrics = false
                var animatedArtPath: String? = null

                if (directFile != null) {
                    val parent = directFile.parentFile
                    if (parent != null) {
                        val siblings = siblingCache.getOrPut(parent.absolutePath) {
                            buildSiblingMap(parent)
                        }
                        val stem = AndroidContracts.stemOf(directFile.name)
                        hasSidecarLyrics = AndroidContracts.LYRICS_EXTENSIONS.any { ext ->
                            siblings.containsKey("$stem.$ext".lowercase())
                        }
                        for (candidate in AndroidContracts.animatedArtCandidatesFor(directFile.name)) {
                            val artFile = siblings[candidate.lowercase()]
                            if (artFile != null && artFile.absolutePath != directFile.absolutePath) {
                                animatedArtPath = artFile.absolutePath
                                break
                            }
                        }
                    }
                }

                val rawTrack = if (colTrack >= 0) cursor.getInt(colTrack) else 0
                val (trackNo, discNo) = AndroidContracts.decodeMediaStoreTrackAndDisc(rawTrack)
                val year = if (colYear >= 0) cursor.getInt(colYear).takeIf { it in 1000..9999 } else null
                val tags = AndroidContracts.WalkedMediaStoreTags(
                    title = if (colTitle >= 0) AndroidContracts.cleanMediaStoreText(cursor.getString(colTitle)) else null,
                    artist = if (colArtist >= 0) AndroidContracts.cleanMediaStoreText(cursor.getString(colArtist)) else null,
                    album = if (colAlbum >= 0) AndroidContracts.cleanMediaStoreText(cursor.getString(colAlbum)) else null,
                    albumArtist = if (colAlbumArtist >= 0) AndroidContracts.cleanMediaStoreText(cursor.getString(colAlbumArtist)) else null,
                    duration = if (durationMs > 0L) durationMs.toDouble() / 1000.0 else null,
                    trackNo = trackNo,
                    discNo = discNo,
                    year = year,
                )

                out.add(
                    AndroidContracts.WalkedAudioEntry(
                        path = resolvedPath,
                        size = size,
                        mtimeMs = mtimeMs,
                        hasSidecarLyrics = hasSidecarLyrics,
                        animatedArtPath = animatedArtPath,
                        displayName = name.ifBlank { directFile?.name },
                        mimeType = mimeType,
                        tags = tags,
                    )
                )

                if (out.size % 50 == 0) {
                    onProgress?.invoke(out.size)
                }
            }
        }
        return out
    }

    private fun buildSiblingMap(dir: File): Map<String, File> {
        val map = HashMap<String, File>()
        dir.listFiles()?.forEach { child ->
            if (child.isFile && !child.name.startsWith(".")) {
                map[child.name.lowercase()] = child
            }
        }
        return map
    }

    private fun walkPosixDir(
        dir: File,
        depth: Int,
        out: MutableList<AndroidContracts.WalkedAudioEntry>,
        onProgress: ((Int) -> Unit)? = null,
    ) {
        if (depth > MAX_SCAN_DEPTH) return
        val entries = dir.listFiles() ?: return
        val subdirs = ArrayList<File>()
        val audioFiles = ArrayList<File>()
        val siblingMap = HashMap<String, File>()

        for (child in entries) {
            val name = child.name
            if (name.startsWith(".")) continue
            if (child.isDirectory) {
                if (!AndroidContracts.shouldSkipDirectoryName(name)) {
                    subdirs.add(child)
                }
            } else if (child.isFile) {
                siblingMap[name.lowercase()] = child
                if (AndroidContracts.isAudioFileName(name)) {
                    audioFiles.add(child)
                }
            }
        }

        val animatedPaths = HashSet<String>()
        for (audio in audioFiles) {
            for (cand in AndroidContracts.animatedArtCandidatesFor(audio.name)) {
                val found = siblingMap[cand.lowercase()]
                if (found != null && found.absolutePath != audio.absolutePath) {
                    animatedPaths.add(found.absolutePath)
                }
            }
        }

        for (audio in audioFiles) {
            if (animatedPaths.contains(audio.absolutePath)) continue
            val stem = AndroidContracts.stemOf(audio.name)
            val hasSidecar = AndroidContracts.LYRICS_EXTENSIONS.any { ext ->
                siblingMap.containsKey("$stem.$ext".lowercase())
            }
            var animatedArtPath: String? = null
            for (cand in AndroidContracts.animatedArtCandidatesFor(audio.name)) {
                val found = siblingMap[cand.lowercase()]
                if (found != null && found.absolutePath != audio.absolutePath) {
                    animatedArtPath = found.absolutePath
                    break
                }
            }
            out.add(
                AndroidContracts.WalkedAudioEntry(
                    path = audio.absolutePath,
                    size = audio.length(),
                    mtimeMs = audio.lastModified().toDouble(),
                    hasSidecarLyrics = hasSidecar,
                    animatedArtPath = animatedArtPath,
                    displayName = audio.name,
                )
            )
            if (out.size % 50 == 0) {
                onProgress?.invoke(out.size)
            }
        }

        for (sub in subdirs) {
            walkPosixDir(sub, depth + 1, out, onProgress)
        }
    }

    private data class SafChildRow(
        val docId: String,
        val uriStr: String,
        val name: String,
        val mimeType: String?,
        val size: Long,
        val mtimeMs: Double,
    )

    /**
     * Walks a SAF folder tree using a single `DocumentsContract.buildChildDocumentsUriUsingTree`
     * cursor query per directory (1 Binder transaction per directory instead of ~6 per entry
     * with `DocumentFile.listFiles()`).
     */
    private fun walkDocumentTreeCursor(
        context: Context,
        treeUri: Uri,
        rootDocId: String,
        out: MutableList<AndroidContracts.WalkedAudioEntry>,
        onProgress: ((Int) -> Unit)? = null,
    ): Boolean {
        val resolver = context.contentResolver
        val queue = ArrayDeque<Pair<String, Int>>()
        queue.add(rootDocId to 0)
        var rootAccessible = false

        while (queue.isNotEmpty()) {
            val (dirDocId, depth) = queue.removeFirst()
            if (depth > MAX_SCAN_DEPTH) continue

            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId)
            val subdirs = ArrayList<String>()
            val audioDocs = ArrayList<SafChildRow>()
            val siblingMap = HashMap<String, String>()

            val queried = try {
                resolver.query(childrenUri, SAF_CHILD_PROJECTION, null, null, null)?.use { cursor ->
                    if (depth == 0) rootAccessible = true
                    val colId = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val colName = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    val colMime = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    val colSize = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                    val colMod = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)

                    if (colId < 0) return@use
                    while (cursor.moveToNext()) {
                        val docId = cursor.getString(colId) ?: continue
                        val name = (if (colName >= 0) cursor.getString(colName) else null) ?: docId.substringAfterLast('/')
                        if (name.isBlank() || name.startsWith(".")) continue
                        val mime = if (colMime >= 0) cursor.getString(colMime) else null

                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            if (!AndroidContracts.shouldSkipDirectoryName(name)) {
                                subdirs.add(docId)
                            }
                        } else {
                            val childDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString()
                            siblingMap[name.lowercase()] = childDocUri
                            if (AndroidContracts.isAudioEntry(name, mime)) {
                                val rawSize = if (colSize >= 0 && !cursor.isNull(colSize)) cursor.getLong(colSize) else 0L
                                val rawMod = if (colMod >= 0 && !cursor.isNull(colMod)) cursor.getLong(colMod) else 0L
                                audioDocs.add(
                                    SafChildRow(
                                        docId = docId,
                                        uriStr = childDocUri,
                                        name = name,
                                        mimeType = mime,
                                        size = rawSize.coerceAtLeast(0L),
                                        mtimeMs = rawMod.toDouble(),
                                    )
                                )
                            }
                        }
                    }
                    true
                } ?: false
            } catch (sec: SecurityException) {
                if (depth == 0) throw sec
                false
            } catch (_: Exception) {
                false
            }

            if (!queried && depth == 0) {
                val rootDoc = DocumentFile.fromTreeUri(context, treeUri)
                if (rootDoc == null || !rootDoc.exists() || !rootDoc.isDirectory) {
                    return false
                }
                rootAccessible = true
            }

            val animatedUris = HashSet<String>()
            for (doc in audioDocs) {
                for (cand in AndroidContracts.animatedArtCandidatesFor(doc.name)) {
                    val foundUri = siblingMap[cand.lowercase()]
                    if (foundUri != null && foundUri != doc.uriStr) {
                        animatedUris.add(foundUri)
                    }
                }
            }

            for (doc in audioDocs) {
                if (animatedUris.contains(doc.uriStr)) continue
                val stem = AndroidContracts.stemOf(doc.name)
                val hasSidecar = AndroidContracts.LYRICS_EXTENSIONS.any { ext ->
                    siblingMap.containsKey("$stem.$ext".lowercase())
                }
                var animatedArtPath: String? = null
                for (cand in AndroidContracts.animatedArtCandidatesFor(doc.name)) {
                    val foundUri = siblingMap[cand.lowercase()]
                    if (foundUri != null && foundUri != doc.uriStr) {
                        animatedArtPath = foundUri
                        break
                    }
                }
                val resolvedSize = if (doc.size > 0L) {
                    doc.size
                } else {
                    queryContentSizeFast(context, Uri.parse(doc.uriStr))
                }
                out.add(
                    AndroidContracts.WalkedAudioEntry(
                        path = doc.uriStr,
                        size = resolvedSize,
                        mtimeMs = doc.mtimeMs,
                        hasSidecarLyrics = hasSidecar,
                        animatedArtPath = animatedArtPath,
                        displayName = doc.name,
                        mimeType = doc.mimeType,
                    )
                )
                if (out.size % 25 == 0) {
                    onProgress?.invoke(out.size)
                }
            }

            for (subId in subdirs) {
                queue.add(subId to (depth + 1))
            }
        }

        return rootAccessible
    }

    private fun queryContentSizeFast(context: Context, uri: Uri): Long {
        try {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                if (afd.length >= 0L) return afd.length
            }
        } catch (_: Exception) {
            // Ignore provider errors and return 0.
        }
        return 0L
    }

    fun probeAudioDuration(context: Context, pathOrUri: String): Double {
        val retriever = MediaMetadataRetriever()
        return try {
            if (pathOrUri.startsWith("content://")) {
                retriever.setDataSource(context, Uri.parse(pathOrUri))
            } else {
                retriever.setDataSource(pathOrUri)
            }
            val ms = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            if (ms > 0L) ms.toDouble() / 1000.0 else 0.0
        } catch (_: Exception) {
            0.0
        } finally {
            try {
                retriever.release()
            } catch (_: Exception) {
                // Ignore release errors on old devices.
            }
        }
    }

    fun statContentUri(context: Context, uriString: String): JSONObject {
        val uri = Uri.parse(uriString)
        val mime = context.contentResolver.getType(uri)
        var size = queryContentSizeFast(context, uri)
        if (size <= 0L) {
            val doc = DocumentFile.fromSingleUri(context, uri)
            if (doc != null && doc.length() > 0) size = doc.length()
        }

        return JSONObject().apply {
            put("size", size)
            put("mimeType", mime ?: JSONObject.NULL)
        }
    }

    fun readContentChunk(context: Context, uriString: String, offset: Long, length: Int): JSObject {
        val uri = Uri.parse(uriString)
        val mime = context.contentResolver.getType(uri)
        val clamped = length.coerceIn(0, 4 * 1024 * 1024)
        var totalSize = 0L

        if (clamped == 0) {
            return JSObject().apply {
                put("base64", "")
                put("totalSize", 0)
                put("mimeType", mime)
            }
        }

        val buf = ByteArray(clamped)
        var bytesRead = 0

        val usedFd = try {
            context.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
                FileInputStream(pfd.fileDescriptor).use { fis ->
                    val channel = fis.channel
                    totalSize = channel.size()
                    if (offset < totalSize) {
                        channel.position(offset)
                        while (bytesRead < clamped) {
                            val n = fis.read(buf, bytesRead, clamped - bytesRead)
                            if (n <= 0) break
                            bytesRead += n
                        }
                    }
                }
                true
            } ?: false
        } catch (_: Exception) {
            false
        }

        if (!usedFd) {
            totalSize = queryContentSizeFast(context, uri)
            context.contentResolver.openInputStream(uri)?.use { stream ->
                if (offset > 0L) {
                    var skipped = 0L
                    while (skipped < offset) {
                        val s = stream.skip(offset - skipped)
                        if (s <= 0) {
                            if (stream.read() == -1) break
                            skipped += 1
                        } else {
                            skipped += s
                        }
                    }
                }
                while (bytesRead < clamped) {
                    val n = stream.read(buf, bytesRead, clamped - bytesRead)
                    if (n <= 0) break
                    bytesRead += n
                }
            } ?: throw IllegalStateException("Cannot open content URI: $uriString")
        }

        val actualSlice = if (bytesRead == buf.size) buf else buf.copyOf(bytesRead)
        val encoded = Base64.encodeToString(actualSlice, Base64.NO_WRAP)
        return JSObject().apply {
            put("base64", encoded)
            put("totalSize", totalSize)
            put("mimeType", mime)
        }
    }

    fun copyContentToFile(context: Context, uriString: String, destPath: String) {
        val uri = Uri.parse(uriString)
        val dest = File(destPath)
        dest.parentFile?.mkdirs()
        context.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(dest).use { output ->
                input.copyTo(output, bufferSize = 64 * 1024)
            }
        } ?: throw IllegalStateException("Cannot read content URI: $uriString")
    }

    fun listSafDirectory(context: Context, dirUriString: String): List<String> {
        val uri = Uri.parse(dirUriString)
        val docId = try {
            DocumentsContract.getDocumentId(uri)
        } catch (_: Exception) {
            try {
                DocumentsContract.getTreeDocumentId(uri)
            } catch (_: Exception) {
                null
            }
        }
        if (!docId.isNullOrBlank()) {
            try {
                val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, docId)
                val out = ArrayList<String>()
                context.contentResolver.query(
                    childrenUri,
                    arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                    null,
                    null,
                    null
                )?.use { cursor ->
                    val colName = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    if (colName >= 0) {
                        while (cursor.moveToNext()) {
                            cursor.getString(colName)?.takeIf { it.isNotBlank() }?.let(out::add)
                        }
                    }
                }
                if (out.isNotEmpty()) return out
            } catch (_: Exception) {
                // Fall back to DocumentFile below.
            }
        }
        val doc = DocumentFile.fromTreeUri(context, uri) ?: return emptyList()
        return doc.listFiles().mapNotNull { it.name }
    }

    fun readSafText(context: Context, uriString: String): String? {
        val uri = Uri.parse(uriString)
        val doc = DocumentFile.fromSingleUri(context, uri)
        if (doc != null && doc.length() > MAX_SIDECAR_BYTES) return null
        return try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                val raw = stream.readBytes()
                if (raw.size > MAX_SIDECAR_BYTES) return null
                raw.toString(Charsets.UTF_8)
            }
        } catch (_: Exception) {
            null
        }
    }

    fun writeSafSidecar(context: Context, audioUriString: String, text: String, ext: String): String {
        val audioUri = Uri.parse(audioUriString)
        val audioDoc = DocumentFile.fromSingleUri(context, audioUri)
            ?: throw IllegalStateException("Cannot resolve audio document")
        val audioName = audioDoc.name ?: "track"
        val sidecarName = "${AndroidContracts.stemOf(audioName)}.$ext"
        val parentUri = parentSafFolderUri(audioUriString)
            ?: throw IllegalStateException("Cannot resolve parent SAF folder")
        val parentDoc = DocumentFile.fromTreeUri(context, Uri.parse(parentUri))
            ?: throw IllegalStateException("Cannot access parent folder for writing")

        val existing = parentDoc.findFile(sidecarName)
        val target = existing ?: parentDoc.createFile("text/plain", sidecarName)
            ?: throw IllegalStateException("Failed to create sidecar file")
        context.contentResolver.openOutputStream(target.uri, "wt")?.use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
        } ?: throw IllegalStateException("Cannot open sidecar for writing")
        return target.uri.toString()
    }

    fun deleteContentUris(context: Context, uris: List<String>): JSONArray {
        val outcomes = JSONArray()
        for (raw in uris) {
            val obj = JSONObject().apply { put("path", raw) }
            try {
                val uri = Uri.parse(raw)
                val deleted = DocumentFile.fromSingleUri(context, uri)?.delete()
                    ?: (context.contentResolver.delete(uri, null, null) > 0)
                obj.put("deleted", deleted)
                obj.put("error", if (deleted) JSONObject.NULL else "System refused deletion")
            } catch (err: Exception) {
                obj.put("deleted", false)
                obj.put("error", err.message ?: "Delete failed")
            }
            outcomes.put(obj)
        }
        return outcomes
    }

    private fun parentSafFolderUri(uriString: String): String? {
        val marker = "/document/"
        val idx = uriString.indexOf(marker)
        if (idx < 0) return null
        val treePart = uriString.substring(0, idx)
        val rawDocId = uriString.substring(idx + marker.length)
        val docId = Uri.decode(rawDocId)
        val sep = docId.lastIndexOf('/')
        val parentDocId = when {
            sep > 0 -> docId.substring(0, sep)
            docId.contains(':') -> docId.substringBefore(':') + ":"
            else -> return null
        }
        val treeUri = Uri.parse(treePart)
        return DocumentsContract.buildDocumentUriUsingTree(treeUri, parentDocId).toString()
    }

    private fun AndroidContracts.WalkedAudioEntry.toJsObject(): JSObject = JSObject().apply {
        put("path", path)
        put("size", size)
        put("mtimeMs", mtimeMs)
        put("hasSidecarLyrics", hasSidecarLyrics)
        put("animatedArtPath", animatedArtPath)
        if (displayName != null) put("displayName", displayName)
        if (mimeType != null) put("mimeType", mimeType)
        if (tags != null) {
            val tagObj = JSObject().apply {
                if (tags.title != null) put("title", tags.title)
                if (tags.artist != null) put("artist", tags.artist)
                if (tags.album != null) put("album", tags.album)
                if (tags.albumArtist != null) put("albumArtist", tags.albumArtist)
                if (tags.duration != null) put("duration", tags.duration)
                if (tags.trackNo != null) put("trackNo", tags.trackNo)
                if (tags.discNo != null) put("discNo", tags.discNo)
                if (tags.year != null) put("year", tags.year)
            }
            put("tags", tagObj)
        }
    }

    private fun errorJsObject(path: String, reason: String): JSObject = JSObject().apply {
        put("path", path)
        put("reason", reason)
    }
}
