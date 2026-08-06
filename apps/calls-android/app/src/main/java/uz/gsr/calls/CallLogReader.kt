package uz.gsr.calls

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import androidx.core.content.ContextCompat

/**
 * The phone's call register, read forward from a boundary the CALLER
 * computes. Android writes a call's row when the call ENDS but stamps it
 * with the START time, so a long call that began before the watermark
 * surfaces after it — the sync therefore reads with a 24 h overlap and
 * relies on the server (and the local table) treating replays as no-ops.
 */
object CallLogReader {

    const val LOOKBACK_MS = 24L * 3600 * 1000

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) ==
            PackageManager.PERMISSION_GRANTED

    /** Calls strictly after `from`, oldest first. */
    fun since(context: Context, from: Long): List<LogEntry> {
        if (!hasPermission(context)) return emptyList()
        val out = ArrayList<LogEntry>()
        runCatching {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
                "${CallLog.Calls.DATE} > ?",
                arrayOf(from.toString()),
                "${CallLog.Calls.DATE} ASC",
            )?.use { c ->
                val iNumber = c.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
                val iType = c.getColumnIndexOrThrow(CallLog.Calls.TYPE)
                val iDate = c.getColumnIndexOrThrow(CallLog.Calls.DATE)
                val iDuration = c.getColumnIndexOrThrow(CallLog.Calls.DURATION)
                while (c.moveToNext()) {
                    val number = c.getString(iNumber)?.trim() ?: continue
                    // Hidden numbers and short codes cannot be in the client
                    // book — the server would refuse them at the schema.
                    if (number.length < 5) continue
                    val entry = when (c.getInt(iType)) {
                        CallLog.Calls.INCOMING_TYPE -> LogEntry(number, "in", c.getLong(iDate), c.getInt(iDuration))
                        CallLog.Calls.OUTGOING_TYPE -> LogEntry(number, "out", c.getLong(iDate), c.getInt(iDuration))
                        // A missed call is CRM news too («client called, nobody
                        // answered») — its duration is ring time, not talk: 0.
                        CallLog.Calls.MISSED_TYPE -> LogEntry(number, "in", c.getLong(iDate), 0)
                        else -> null
                    } ?: continue
                    out.add(entry)
                }
            }
        }
        return out
    }
}
