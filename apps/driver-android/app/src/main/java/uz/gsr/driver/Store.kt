package uz.gsr.driver

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** One queued GPS fix waiting to be uploaded. */
data class Fix(
    val id: Long,
    val lat: Double,
    val lon: Double,
    val accuracy: Int,
    val speed: Double,
    val recordedAt: Long,
)

/**
 * Trip settings + the offline queue.
 *
 * The corridor (China → Kyrgyzstan → Uzbekistan) has long stretches with no
 * data at all, so every fix is written to SQLite first and only deleted once
 * the server has accepted it. Nothing is ever lost to a dead zone.
 */
class Store(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "gsrdriver.db", null, 1) {

    companion object {
        /** Owner's call: a truck position every couple of hours is plenty. */
        const val DEFAULT_INTERVAL_MINUTES = 120
    }

    private val prefs =
        context.applicationContext.getSharedPreferences("gsrdriver", Context.MODE_PRIVATE)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "lat REAL NOT NULL, lon REAL NOT NULL, acc INTEGER NOT NULL, " +
                "spd REAL NOT NULL, ts INTEGER NOT NULL)"
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS fixes")
        onCreate(db)
    }

    // --- Trip settings -----------------------------------------------------

    var server: String
        get() = prefs.getString("server", BuildConfig.DEFAULT_SERVER) ?: BuildConfig.DEFAULT_SERVER
        set(value) = prefs.edit().putString("server", value.trim().trimEnd('/')).apply()

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    var tripLabel: String
        get() = prefs.getString("trip", "") ?: ""
        set(value) = prefs.edit().putString("trip", value).apply()

    var lastSentAt: Long
        get() = prefs.getLong("lastSent", 0L)
        set(value) = prefs.edit().putLong("lastSent", value).apply()

    var lastError: String
        get() = prefs.getString("lastError", "") ?: ""
        set(value) = prefs.edit().putString("lastError", value).apply()

    /** Minutes between position reports — the driver's battery depends on it. */
    var intervalMinutes: Int
        get() = prefs.getInt("interval", DEFAULT_INTERVAL_MINUTES)
        set(value) = prefs.edit().putInt("interval", value).apply()

    /** When the next report is due (shown on the status screen). */
    var nextTickAt: Long
        get() = prefs.getLong("nextTick", 0L)
        set(value) = prefs.edit().putLong("nextTick", value).apply()

    /**
     * The OEM auto-start whitelist (Xiaomi/Huawei/Oppo/Vivo) cannot be read
     * back from an app, so the warehouse worker ticks it off by hand.
     */
    var autostartConfirmed: Boolean
        get() = prefs.getBoolean("autostart", false)
        set(value) = prefs.edit().putBoolean("autostart", value).apply()

    val lastFixAt: Long get() = prefs.getLong("fixAt", 0L)
    val lastFixLat: Double get() = prefs.getString("fixLat", null)?.toDoubleOrNull() ?: 0.0
    val lastFixLon: Double get() = prefs.getString("fixLon", null)?.toDoubleOrNull() ?: 0.0

    fun rememberFix(lat: Double, lon: Double, at: Long) {
        prefs.edit()
            .putString("fixLat", lat.toString())
            .putString("fixLon", lon.toString())
            .putLong("fixAt", at)
            .apply()
    }

    val isPaired: Boolean get() = !token.isNullOrEmpty()

    /** Trip finished or link revoked: forget everything, keep no history. */
    fun clearTrip() {
        prefs.edit()
            .remove("token")
            .remove("trip")
            .remove("lastSent")
            .remove("lastError")
            .remove("nextTick")
            .remove("fixAt")
            .remove("fixLat")
            .remove("fixLon")
            .apply()
        writableDatabase.delete("fixes", null, null)
    }

    // --- Queue -------------------------------------------------------------

    fun enqueue(lat: Double, lon: Double, accuracy: Float, speed: Float, recordedAt: Long) {
        writableDatabase.execSQL(
            "INSERT INTO fixes (lat, lon, acc, spd, ts) VALUES (?, ?, ?, ?, ?)",
            arrayOf<Any>(lat, lon, accuracy.toInt(), speed.toDouble(), recordedAt),
        )
    }

    fun pending(limit: Int): List<Fix> {
        val out = ArrayList<Fix>()
        readableDatabase.rawQuery(
            "SELECT id, lat, lon, acc, spd, ts FROM fixes ORDER BY ts ASC LIMIT ?",
            arrayOf(limit.toString()),
        ).use { c ->
            while (c.moveToNext()) {
                out.add(
                    Fix(
                        id = c.getLong(0),
                        lat = c.getDouble(1),
                        lon = c.getDouble(2),
                        accuracy = c.getInt(3),
                        speed = c.getDouble(4),
                        recordedAt = c.getLong(5),
                    )
                )
            }
        }
        return out
    }

    fun delete(fixes: List<Fix>) {
        if (fixes.isEmpty()) return
        val ids = fixes.joinToString(",") { it.id.toString() }
        writableDatabase.execSQL("DELETE FROM fixes WHERE id IN ($ids)")
    }

    fun pendingCount(): Int {
        readableDatabase.rawQuery("SELECT count(*) FROM fixes", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }
}
