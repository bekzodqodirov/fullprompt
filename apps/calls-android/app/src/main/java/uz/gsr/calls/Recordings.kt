package uz.gsr.calls

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.InputStream
import java.util.Locale

/**
 * Finds the file the phone's OWN call recorder wrote for one call.
 *
 * v1.1: MediaStore FIRST, File API only as the pre-scoped-storage fallback.
 * On Android 13+ the audio permission grants access to other apps'
 * recordings THROUGH MediaStore — but `File.listFiles()` on their folder
 * (and even `File.isFile` on a path MediaStore returned) can silently
 * answer nothing, which is exactly what v1.0 shipped: the owner's Samsung
 * had the files sitting in Recordings/Call and the app uploaded zero.
 * A candidate is therefore carried as a content URI and STREAMED via the
 * resolver, never touched as a File on modern Android.
 *
 * A candidate matches when its mtime sits in the call's window (recorders
 * close the file at hang-up) AND it says «call» in its path or carries the
 * number's tail in its name — a voice memo taped during the call window
 * must never be mistaken for the call and uploaded.
 */
object Recordings {

    /** Vendor folders that hold call recordings and nothing else. */
    private val CALL_DIRS = listOf(
        "MIUI/sound_recorder/call_rec", // Xiaomi / Redmi / POCO
        "Recordings/Call", // Samsung
        "Sounds/CallRecord", // Huawei / Honor
        "Record/Call", // Vivo / iQOO
        "Music/Recordings/Call Recordings", // Oppo / Realme
        "PhoneRecord", // Meizu and a few odd builds
    )

    private val AUDIO_EXT = setOf("mp3", "m4a", "amr", "aac", "wav", "ogg", "opus", "3gp", "3gpp", "awb")

    /** The server refuses bigger uploads (413) — do not carry them at all. */
    const val MAX_BYTES = 25L * 1024 * 1024

    /** How long after hang-up a file may still appear (slow writers, sync). */
    private const val AFTER_MS = 10L * 60 * 1000
    private const val BEFORE_MS = 90L * 1000

    /** One found recording, openable without the File API. */
    class Rec(
        val name: String,
        val sizeBytes: Long,
        private val uri: Uri?,
        private val file: File?,
        val score: Long,
    ) {
        fun open(context: Context): InputStream? = runCatching {
            if (uri != null) context.contentResolver.openInputStream(uri) else file?.inputStream()
        }.getOrNull()
    }

    fun findFor(context: Context, phone: String, startedAt: Long, durationSec: Int): Rec? {
        val endAt = startedAt + durationSec * 1000L
        val windowFrom = startedAt - BEFORE_MS
        val windowTo = endAt + AFTER_MS
        val tail = phone.filter { it.isDigit() }.takeLast(7)

        val candidates = ArrayList<Rec>()

        fun consider(name: String, path: String, mtimeMs: Long, size: Long, uri: Uri?, file: File?) {
            val lowerName = name.lowercase(Locale.US)
            if (lowerName.substringAfterLast('.', "") !in AUDIO_EXT) return
            if (mtimeMs < windowFrom || mtimeMs > windowTo) return
            if (size == 0L || size > MAX_BYTES) return
            val nameHasNumber = tail.length >= 5 && name.filter { it.isDigit() }.contains(tail)
            val pathSaysCall = path.lowercase(Locale.US).contains("call")
            // The privacy fence: a file is a call recording when its FOLDER
            // says so or its NAME carries the caller's number — never on a
            // bare time coincidence.
            if (!nameHasNumber && !pathSaysCall) return
            var score = Math.abs(mtimeMs - endAt)
            if (nameHasNumber) score -= 100L * 60 * 1000
            candidates.add(Rec(name, size, uri, file, score))
        }

        // MediaStore — the road that stays open under scoped storage.
        runCatching {
            val projection = arrayOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.DATE_MODIFIED,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.DATA,
            )
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection,
                "${MediaStore.Audio.Media.DATE_MODIFIED} BETWEEN ? AND ?",
                arrayOf((windowFrom / 1000).toString(), (windowTo / 1000).toString()),
                null,
            )?.use { c ->
                val iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val iDate = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
                val iSize = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
                val iData = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA)
                while (c.moveToNext()) {
                    val uri = ContentUris.withAppendedId(
                        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                        c.getLong(iId),
                    )
                    consider(
                        name = c.getString(iName) ?: continue,
                        path = c.getString(iData) ?: "",
                        mtimeMs = c.getLong(iDate) * 1000,
                        size = c.getLong(iSize),
                        uri = uri,
                        file = null,
                    )
                }
            }
        }

        // Pre-scoped-storage Android (≤10): the vendor folders directly.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R && candidates.isEmpty()) {
            val root = Environment.getExternalStorageDirectory()
            for (dir in CALL_DIRS) {
                val folder = File(root, dir)
                if (!folder.isDirectory) continue
                runCatching {
                    folder.listFiles()?.forEach { f ->
                        consider(f.name, f.absolutePath, f.lastModified(), f.length(), null, f)
                    }
                }
            }
        }

        return candidates.minByOrNull { it.score }
    }
}
