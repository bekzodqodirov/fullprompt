package uz.gsr.calls

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** A matched call whose recording has not been uploaded yet. */
data class PendingAudio(val phone: String, val startedAt: Long, val durationSec: Int)

/**
 * Settings + the list of calls still waiting for their recording.
 *
 * ONLY matched calls are written here — the server's verdict decides. A
 * personal call leaves no row on the phone either: the same privacy line the
 * server draws (`matched: false` is never stored) holds on both ends.
 */
class Store(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "gsrcalls.db", null, 1) {

    companion object {
        /** JobScheduler's floor for a periodic job — also plenty here. */
        const val INTERVAL_MINUTES = 15

        /** Audio states. */
        const val AUDIO_PENDING = 0
        const val AUDIO_SENT = 1
        const val AUDIO_REFUSED = 2
        const val AUDIO_EXPIRED = 3
    }

    private val prefs =
        context.applicationContext.getSharedPreferences("gsrcalls", Context.MODE_PRIVATE)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE calls (phone TEXT NOT NULL, started INTEGER NOT NULL, " +
                "dur INTEGER NOT NULL, audio INTEGER NOT NULL DEFAULT 0, " +
                "PRIMARY KEY (phone, started))",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS calls")
        onCreate(db)
    }

    // --- Settings ----------------------------------------------------------

    var server: String
        get() = prefs.getString("server", BuildConfig.DEFAULT_SERVER) ?: BuildConfig.DEFAULT_SERVER
        set(value) = prefs.edit().putString("server", value.trim().trimEnd('/')).apply()

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    /**
     * The newest call-log timestamp already reported. Initialised at pairing
     * to the start of THAT day — the owner's answer: recording starts from
     * the day the app is installed, no history is read back.
     */
    var lastLogAt: Long
        get() = prefs.getLong("lastLog", 0L)
        set(value) = prefs.edit().putLong("lastLog", value).apply()

    /**
     * The install-day boundary, fixed at pairing. The re-read overlap walks
     * the watermark BACK each cycle (long calls surface late), and without
     * this floor the first cycles would reach into the day before the owner
     * said recording begins.
     */
    var installFloor: Long
        get() = prefs.getLong("floor", 0L)
        set(value) = prefs.edit().putLong("floor", value).apply()

    var lastSyncAt: Long
        get() = prefs.getLong("lastSync", 0L)
        set(value) = prefs.edit().putLong("lastSync", value).apply()

    var lastError: String
        get() = prefs.getString("lastError", "") ?: ""
        set(value) = prefs.edit().putString("lastError", value).apply()

    /** Running totals for the status screen. */
    var sentCalls: Int
        get() = prefs.getInt("sentCalls", 0)
        set(value) = prefs.edit().putInt("sentCalls", value).apply()

    var sentAudio: Int
        get() = prefs.getInt("sentAudio", 0)
        set(value) = prefs.edit().putInt("sentAudio", value).apply()

    /** Last audio pass, «pending/found/sent/refused» — the screen's eyes. */
    var audioStatus: String
        get() = prefs.getString("audioStatus", "") ?: ""
        set(value) = prefs.edit().putString("audioStatus", value).apply()

    /** The OEM auto-start whitelist cannot be read back — ticked by hand. */
    var autostartConfirmed: Boolean
        get() = prefs.getBoolean("autostart", false)
        set(value) = prefs.edit().putBoolean("autostart", value).apply()

    /** The phone's own call recorder — no API can check it, ticked by hand. */
    var recorderConfirmed: Boolean
        get() = prefs.getBoolean("recorder", false)
        set(value) = prefs.edit().putBoolean("recorder", value).apply()

    val isPaired: Boolean get() = !token.isNullOrEmpty()

    /** Revoked or unpaired: forget everything, keep no history. */
    fun clearAll() {
        prefs.edit()
            .remove("token")
            .remove("lastLog")
            .remove("floor")
            .remove("lastSync")
            .remove("lastError")
            .remove("sentCalls")
            .remove("sentAudio")
            .remove("audioStatus")
            .apply()
        runCatching { writableDatabase.delete("calls", null, null) }
    }

    // --- Matched calls waiting for audio -----------------------------------

    /**
     * `true` only for a NEW row: the 24 h re-read overlap replays known calls
     * every cycle, and the status screen's counter must not count a replay.
     */
    fun rememberMatched(phone: String, startedAt: Long, durationSec: Int): Boolean {
        return runCatching {
            val values = android.content.ContentValues().apply {
                put("phone", phone)
                put("started", startedAt)
                put("dur", durationSec)
                put("audio", AUDIO_PENDING)
            }
            writableDatabase.insertWithOnConflict(
                "calls",
                null,
                values,
                SQLiteDatabase.CONFLICT_IGNORE,
            ) != -1L
        }.getOrDefault(false)
    }

    fun pendingAudio(limit: Int): List<PendingAudio> {
        val out = ArrayList<PendingAudio>()
        readableDatabase.rawQuery(
            "SELECT phone, started, dur FROM calls WHERE audio = 0 ORDER BY started ASC LIMIT ?",
            arrayOf(limit.toString()),
        ).use { c ->
            while (c.moveToNext()) {
                out.add(PendingAudio(c.getString(0), c.getLong(1), c.getInt(2)))
            }
        }
        return out
    }

    fun markAudio(phone: String, startedAt: Long, state: Int) {
        runCatching {
            writableDatabase.execSQL(
                "UPDATE calls SET audio = ? WHERE phone = ? AND started = ?",
                arrayOf<Any>(state, phone, startedAt),
            )
        }
    }

    fun pendingAudioCount(): Int {
        readableDatabase.rawQuery("SELECT count(*) FROM calls WHERE audio = 0", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    /** Rows older than a week say nothing anyone will act on — drop them. */
    fun prune(now: Long) {
        runCatching {
            writableDatabase.execSQL(
                "DELETE FROM calls WHERE started < ?",
                arrayOf<Any>(now - 7L * 24 * 3600 * 1000),
            )
        }
    }
}
