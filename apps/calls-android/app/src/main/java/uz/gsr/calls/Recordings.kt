package uz.gsr.calls

import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.util.Locale

/**
 * Finds the file the phone's OWN call recorder wrote for one call.
 *
 * Android gives no app the call audio (since 10), so Samsung/Xiaomi/… write
 * the recording themselves into a folder of their choosing, and this app
 * only picks it up. Two ways in, both media-permission only:
 *
 *  · the vendors' known call-recording folders, scanned directly — these
 *    folders hold NOTHING but call recordings, so a time match is enough;
 *  · a MediaStore query for audio whose path says "call" — the net for a
 *    vendor we did not list. A generic recordings folder is deliberately
 *    NOT scanned: a voice memo taped during the call window must never be
 *    mistaken for the call and uploaded.
 *
 * A candidate matches when its mtime sits in the call's window (the
 * recorder closes the file at hang-up), and the one whose name carries the
 * number's tail wins over a bare time match — Xiaomi and Samsung both put
 * the number or contact in the filename.
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

    data class Candidate(val file: File, val score: Long)

    fun findFor(context: Context, phone: String, startedAt: Long, durationSec: Int): File? {
        val endAt = startedAt + durationSec * 1000L
        val windowFrom = startedAt - BEFORE_MS
        val windowTo = endAt + AFTER_MS
        val tail = phone.filter { it.isDigit() }.takeLast(7)

        val candidates = ArrayList<Candidate>()
        fun consider(file: File) {
            val name = file.name.lowercase(Locale.US)
            if (name.substringAfterLast('.', "") !in AUDIO_EXT) return
            val mtime = file.lastModified()
            if (mtime < windowFrom || mtime > windowTo) return
            if (file.length() == 0L || file.length() > MAX_BYTES) return
            // Closest to the hang-up wins; a filename naming the number beats
            // any bare time match (several calls can share a window).
            var score = Math.abs(mtime - endAt)
            if (tail.length >= 5 && file.name.filter { it.isDigit() }.contains(tail)) {
                score -= 100L * 60 * 1000
            }
            candidates.add(Candidate(file, score))
        }

        val root = Environment.getExternalStorageDirectory()
        for (dir in CALL_DIRS) {
            val folder = File(root, dir)
            if (!folder.isDirectory) continue
            runCatching { folder.listFiles()?.forEach(::consider) }
        }

        // The net: any audio MediaStore indexed whose path mentions call
        // recording — catches a vendor folder not on the list above.
        runCatching {
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Audio.Media.DATA, MediaStore.Audio.Media.DATE_MODIFIED),
                "${MediaStore.Audio.Media.DATE_MODIFIED} BETWEEN ? AND ?",
                arrayOf((windowFrom / 1000).toString(), (windowTo / 1000).toString()),
                null,
            )?.use { c ->
                val iData = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA)
                while (c.moveToNext()) {
                    val path = c.getString(iData) ?: continue
                    val lower = path.lowercase(Locale.US)
                    if (!lower.contains("call")) continue
                    val file = File(path)
                    if (file.isFile) consider(file)
                }
            }
        }

        return candidates.minByOrNull { it.score }?.file
    }
}
