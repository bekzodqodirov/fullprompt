package uz.gsr.driver

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Result of the one-time pairing exchange. */
data class PairResult(val token: String, val batchCode: String, val driverName: String?)

/** Thrown when the server says this trip is over — the app must stop. */
class TripFinished : Exception("trip finished")

/**
 * Tiny HTTP client (no third-party networking library on purpose — the app
 * must install and run on any Android phone, including Chinese ones without
 * Google services, so the dependency list stays as short as possible).
 */
object Api {

    private fun iso(millis: Long): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date(millis))
    }

    private fun open(server: String, path: String, token: String?): HttpURLConnection {
        val connection = URL("$server$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.connectTimeout = 20_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("Content-Type", "application/json")
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

    /** Exchange the 6-character code shown on the batch card for a trip token. */
    fun pair(server: String, code: String): PairResult {
        val connection = open(server, "/api/track/pair", null)
        try {
            val body = JSONObject()
                .put("pairCode", code.trim().uppercase(Locale.US))
                .put("platform", "android")
                .toString()
            connection.outputStream.use { it.write(body.toByteArray()) }
            val text = readBody(connection)
            if (connection.responseCode !in 200..299) {
                val error = runCatching { JSONObject(text).optString("error") }.getOrDefault("")
                throw Exception(if (error.isEmpty()) "HTTP ${connection.responseCode}" else error)
            }
            val json = JSONObject(text)
            return PairResult(
                token = json.getString("token"),
                batchCode = json.optString("batchCode"),
                driverName = json.optString("driverName").ifEmpty { null },
            )
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Upload a queued batch of fixes. Re-sending after a flaky connection is
     * safe — the server ignores duplicates.
     */
    fun upload(server: String, token: String, fixes: List<Fix>) {
        val positions = JSONArray()
        for (fix in fixes) {
            val item = JSONObject()
                .put("lat", fix.lat)
                .put("lon", fix.lon)
                .put("recordedAt", iso(fix.recordedAt))
            if (fix.accuracy > 0) item.put("accuracyM", fix.accuracy)
            if (fix.speed > 0) item.put("speedKmh", fix.speed)
            positions.put(item)
        }
        val connection = open(server, "/api/track/positions", token)
        try {
            val body = JSONObject().put("positions", positions).toString()
            connection.outputStream.use { it.write(body.toByteArray()) }
            val code = connection.responseCode
            readBody(connection)
            // 410: the batch was closed — stop and forget the token.
            if (code == 410) throw TripFinished()
            if (code !in 200..299) throw Exception("HTTP $code")
        } finally {
            connection.disconnect()
        }
    }
}
