package uz.gsr.calls

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** One call-log row on its way to the server. */
data class LogEntry(
    val phone: String,
    val direction: String, // "in" | "out"
    val startedAt: Long, // epoch ms
    val durationSec: Int,
)

/** The server's per-call answer: does the client book know this number? */
data class Verdict(val phone: String, val startedAt: Long, val matched: Boolean)

/** Thrown when the server says this pairing is over — the app must stop. */
class Revoked : Exception("revoked")

/** The upload's terminal refusals (never retried; a network error IS retried). */
class AudioRefused(val reason: String) : Exception(reason)

/**
 * Tiny HTTP client — no third-party networking library, the driver app's
 * rule: the APK must install on any phone, including Chinese ones without
 * Google services, so the dependency list stays as short as possible.
 */
object Api {

    private fun open(server: String, path: String, token: String?, contentType: String): HttpURLConnection {
        val connection = URL("$server$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = 20_000
        connection.readTimeout = 60_000
        connection.setRequestProperty("Content-Type", contentType)
        if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
        return connection
    }

    private fun readBody(connection: HttpURLConnection): String {
        val stream = if (connection.responseCode in 200..299) {
            connection.inputStream
        } else {
            connection.errorStream
        }
        return stream?.bufferedReader()?.use { it.readText() } ?: ""
    }

    /** Exchange the single-use code from /profile for a long-lived token. */
    fun pair(server: String, code: String): String {
        val connection = open(server, "/api/calls/pair", null, "application/json")
        try {
            val body = JSONObject()
                .put("pairCode", code.trim().uppercase())
                .put("platform", "android")
                .toString()
            connection.outputStream.use { it.write(body.toByteArray()) }
            val text = readBody(connection)
            if (connection.responseCode !in 200..299) {
                val error = runCatching { JSONObject(text).optString("error") }.getOrDefault("")
                throw Exception(if (error.isEmpty()) "HTTP ${connection.responseCode}" else error)
            }
            return JSONObject(text).getString("token")
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Post a batch of call-log rows; the server answers per call whether the
     * client book matched. Re-sending after a flaky connection is safe — the
     * server ignores duplicates.
     */
    fun postLogs(server: String, token: String, calls: List<LogEntry>): List<Verdict> {
        val items = JSONArray()
        for (call in calls) {
            items.put(
                JSONObject()
                    .put("phone", call.phone)
                    .put("direction", call.direction)
                    .put("startedAt", call.startedAt)
                    .put("durationSec", call.durationSec),
            )
        }
        val connection = open(server, "/api/calls/logs", token, "application/json")
        try {
            connection.outputStream.use { it.write(JSONObject().put("calls", items).toString().toByteArray()) }
            val code = connection.responseCode
            val text = readBody(connection)
            // 410: the pairing was revoked on /profile — stop and forget.
            if (code == 410) throw Revoked()
            if (code !in 200..299) throw Exception("HTTP $code")
            val verdicts = JSONObject(text).getJSONArray("verdicts")
            val out = ArrayList<Verdict>(verdicts.length())
            for (i in 0 until verdicts.length()) {
                val v = verdicts.getJSONObject(i)
                out.add(Verdict(v.getString("phone"), v.getLong("startedAt"), v.getBoolean("matched")))
            }
            return out
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Upload one recording for a call the server already knows. `true` means
     * the server holds the audio (fresh or already) — the file is done.
     */
    fun uploadAudio(server: String, token: String, file: File, phone: String, startedAt: Long): Boolean {
        val boundary = "----gsrcalls${System.currentTimeMillis()}"
        val connection = open(server, "/api/calls/audio", token, "multipart/form-data; boundary=$boundary")
        // The file can be many megabytes: stream it, never buffer the whole
        // request in memory alongside the phone's other apps.
        connection.setChunkedStreamingMode(64 * 1024)
        try {
            connection.outputStream.buffered().use { out ->
                fun field(name: String, value: String) {
                    out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
                }
                field("phone", phone)
                field("startedAt", startedAt.toString())
                out.write(
                    ("--$boundary\r\nContent-Disposition: form-data; name=\"audio\"; " +
                        "filename=\"${file.name.replace("\"", "")}\"\r\n" +
                        "Content-Type: application/octet-stream\r\n\r\n").toByteArray(),
                )
                file.inputStream().use { it.copyTo(out) }
                out.write("\r\n--$boundary--\r\n".toByteArray())
            }
            val code = connection.responseCode
            readBody(connection)
            if (code == 410) throw Revoked()
            if (code in 200..299) return true
            // The server's named refusals are final for THIS file: the call is
            // unknown (404), the file is too big (413) or not audio (415).
            // Retrying any of them would re-send megabytes for ever.
            if (code == 404 || code == 413 || code == 415) throw AudioRefused("HTTP $code")
            throw Exception("HTTP $code")
        } finally {
            connection.disconnect()
        }
    }
}
