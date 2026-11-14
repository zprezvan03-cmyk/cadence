package app.cadence.player

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

object CadenceStorageHelper {
    private const val MAX_SCAN_DEPTH = 32
    private const val MAX_SIDECAR_BYTES = 2L * 1024L * 1024L

    data class PermissionStatus(
        val audioGranted: Boolean,
        val notificationsGranted: Boolean,
        val sdkInt: Int,
        val missingPermissions: Array<String>,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("audioGranted", audioGranted)
            put("notificationsGranted", notificationsGranted)
            put("sdkInt", sdkInt)
        }
    }

    fun checkPermissions(context: Context): PermissionStatus {
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
            if (!granted) missing.add(Manifest.permission.POST_NOTIFICATIONS)
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

    fun walkFolders(context: Context, folders: List<String>): JSONObject {
        val filesOut = JSONArray()
        val errorsOut = JSONArray()
        val seen = HashSet<String>()

        for (folder in folders) {
            try {
                when {
                    folder == "mediastore://audio" -> {
                        val entries = scanMediaStore(context)
                        for (entry in entries) {
                            if (seen.add(entry.path)) filesOut.put(entry.toJson())
                        }
                    }
                    folder.startsWith("content://") -> {
                        val treeUri = Uri.parse(folder)
                        val rootDoc = DocumentFile.fromTreeUri(context, treeUri)
                        if (rootDoc == null || !rootDoc.exists() || !rootDoc.isDirectory) {
                            errorsOut.put(errorJson(folder, "Cannot access selected folder (permission revoked or unavailable)"))
                        } else {
                            val entries = ArrayList<AndroidContracts.WalkedAudioEntry>()
                            walkDocumentTree(rootDoc, 0, entries)
                            for (entry in entries) {
                                if (seen.add(entry.path)) filesOut.put(entry.toJson())
                            }
                        }
                    }
                    else -> {
                        val dir = File(folder)
                        if (!dir.exists() || !dir.isDirectory) {
                            errorsOut.put(errorJson(folder, "Not a directory"))
                        } else {
                            val entries = ArrayList<AndroidContracts.WalkedAudioEntry>()
                            walkPosixDir(dir, 0, entries)
                            for (entry in entries) {
                                if (seen.add(entry.path)) filesOut.put(entry.toJson())
                            }
                        }
                    }
                }
            } catch (err: Exception) {
                errorsOut.put(errorJson(folder, err.message ?: "Scan error"))
            }
        }

        return JSONObject().apply {
            put("files", filesOut)
            put("errors", errorsOut)
        }
    }

    private fun scanMediaStore(context: Context): List<AndroidContracts.WalkedAudioEntry> {
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

        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.IS_MUSIC,
            MediaStore.Audio.Media.DURATION,
        )

        context.contentResolver.query(
            uri,
            projection,
            "${MediaStore.Audio.Media.SIZE} > 0",
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

            val siblingCache = HashMap<String, Map<String, File>>()

            while (cursor.moveToNext()) {
                val id = cursor.getLong(colId)
                val name = cursor.getString(colName) ?: ""
                val isMusic = if (colIsMusic >= 0) cursor.getInt(colIsMusic) != 0 else true
                val durationMs = if (colDuration >= 0) cursor.getLong(colDuration) else 0L

                val dataPath = if (colData >= 0) cursor.getString(colData) else null
                val fileName = if (name.isNotBlank()) name else dataPath.orEmpty()
                if (!AndroidContracts.isAudioFileName(fileName)) continue

                // Skip tiny notification/ringtone clips unless explicitly tagged as music.
                if (!isMusic && durationMs in 1..4999) continue
                if (dataPath != null && (dataPath.contains("/Notifications/") || dataPath.contains("/Ringtones/") || dataPath.contains("/Alarms/"))) {
                    if (!isMusic) continue
                }

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

                out.add(
                    AndroidContracts.WalkedAudioEntry(
                        path = resolvedPath,
                        size = size,
                        mtimeMs = mtimeMs,
                        hasSidecarLyrics = hasSidecarLyrics,
                        animatedArtPath = animatedArtPath,
                    )
                )
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
                if (!AndroidContracts.SKIP_DIRECTORIES.contains(name)) {
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
                )
            )
        }

        for (sub in subdirs) {
            walkPosixDir(sub, depth + 1, out)
        }
    }

    private fun walkDocumentTree(
        dir: DocumentFile,
        depth: Int,
        out: MutableList<AndroidContracts.WalkedAudioEntry>,
    ) {
        if (depth > MAX_SCAN_DEPTH) return
        val children = dir.listFiles()
        val subdirs = ArrayList<DocumentFile>()
        val audioDocs = ArrayList<DocumentFile>()
        val siblingMap = HashMap<String, DocumentFile>()

        for (child in children) {
            val name = child.name ?: continue
            if (name.startsWith(".")) continue
            if (child.isDirectory) {
                if (!AndroidContracts.SKIP_DIRECTORIES.contains(name)) {
                    subdirs.add(child)
                }
            } else if (child.isFile) {
                siblingMap[name.lowercase()] = child
                if (AndroidContracts.isAudioFileName(name)) {
                    audioDocs.add(child)
                }
            }
        }

        val animatedUris = HashSet<String>()
        for (doc in audioDocs) {
            val name = doc.name ?: continue
            for (cand in AndroidContracts.animatedArtCandidatesFor(name)) {
                val found = siblingMap[cand.lowercase()]
                if (found != null && found.uri != doc.uri) {
                    animatedUris.add(found.uri.toString())
                }
            }
        }

        for (doc in audioDocs) {
            val uriStr = doc.uri.toString()
            if (animatedUris.contains(uriStr)) continue
            val name = doc.name ?: continue
            val stem = AndroidContracts.stemOf(name)
            val hasSidecar = AndroidContracts.LYRICS_EXTENSIONS.any { ext ->
                siblingMap.containsKey("$stem.$ext".lowercase())
            }
            var animatedArtPath: String? = null
            for (cand in AndroidContracts.animatedArtCandidatesFor(name)) {
                val found = siblingMap[cand.lowercase()]
                if (found != null && found.uri != doc.uri) {
                    animatedArtPath = found.uri.toString()
                    break
                }
            }
            out.add(
                AndroidContracts.WalkedAudioEntry(
                    path = uriStr,
                    size = doc.length().coerceAtLeast(0L),
                    mtimeMs = doc.lastModified().toDouble(),
                    hasSidecarLyrics = hasSidecar,
                    animatedArtPath = animatedArtPath,
                )
            )
        }

        for (sub in subdirs) {
            walkDocumentTree(sub, depth + 1, out)
        }
    }

    fun statContentUri(context: Context, uriString: String): JSONObject {
        val uri = Uri.parse(uriString)
        val mime = context.contentResolver.getType(uri)
        var size = 0L

        try {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                if (afd.length >= 0) size = afd.length
            }
        } catch (_: Exception) {
            // Fall back to DocumentFile / stream query.
        }
        if (size <= 0L) {
            val doc = DocumentFile.fromSingleUri(context, uri)
            if (doc != null && doc.length() > 0) size = doc.length()
        }

        return JSONObject().apply {
            put("size", size)
            put("mimeType", mime ?: JSONObject.NULL)
        }
    }

    fun readContentChunk(context: Context, uriString: String, offset: Long, length: Int): JSONObject {
        val uri = Uri.parse(uriString)
        val mime = context.contentResolver.getType(uri)
        val clamped = length.coerceIn(0, 4 * 1024 * 1024)
        var totalSize = 0L

        if (clamped == 0) {
            return JSONObject().apply {
                put("base64", "")
                put("totalSize", 0)
                put("mimeType", mime ?: JSONObject.NULL)
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
            context.contentResolver.openInputStream(uri)?.use { stream ->
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
                while (bytesRead < clamped) {
                    val n = stream.read(buf, bytesRead, clamped - bytesRead)
                    if (n <= 0) break
                    bytesRead += n
                }
            } ?: throw IllegalStateException("Cannot open content URI: $uriString")
        }

        val actualSlice = if (bytesRead == buf.size) buf else buf.copyOf(bytesRead)
        val encoded = Base64.encodeToString(actualSlice, Base64.NO_WRAP)
        return JSONObject().apply {
            put("base64", encoded)
            put("totalSize", totalSize)
            put("mimeType", mime ?: JSONObject.NULL)
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

    private fun AndroidContracts.WalkedAudioEntry.toJson(): JSONObject = JSONObject().apply {
        put("path", path)
        put("size", size)
        put("mtimeMs", mtimeMs)
        put("hasSidecarLyrics", hasSidecarLyrics)
        put("animatedArtPath", animatedArtPath ?: JSONObject.NULL)
    }

    private fun errorJson(path: String, reason: String): JSONObject = JSONObject().apply {
        put("path", path)
        put("reason", reason)
    }
}
