package uz.gsr.calls

import android.content.Context

/**
 * The one sync cycle, shared by the scheduled job and the «Sync now» button.
 *
 * Order matters: the LOG travels first, because the server only accepts
 * audio for a call it already knows — and its verdicts are what tell the
 * phone which recordings deserve uploading at all. A call the client book
 * refused is dropped on both ends and its recording never leaves the phone.
 */
object Sync {

    /** Bounded per cycle: an upload burst must fit a job's execution window. */
    private const val AUDIO_PER_CYCLE = 10
    private const val LOG_BATCH = 200

    /** A recording that has not appeared within 48 h never will. */
    private const val AUDIO_WAIT_MS = 48L * 3600 * 1000

    enum class Outcome { OK, OFFLINE, REVOKED }

    fun cycle(context: Context, store: Store): Outcome {
        val token = store.token ?: return Outcome.OK
        val now = System.currentTimeMillis()

        try {
            // 1. New call-log rows → the server, in schema-sized batches.
            //    The watermark advances only AFTER a batch is accepted, so a
            //    dead zone repeats the batch instead of losing it. The
            //    overlap never crosses the install-day floor — the owner's
            //    boundary: nothing before that day is ever read.
            val from = maxOf(store.lastLogAt - CallLogReader.LOOKBACK_MS, store.installFloor)
            val entries = CallLogReader.since(context, from)
            for (chunk in entries.chunked(LOG_BATCH)) {
                val verdicts = Api.postLogs(store.server, token, chunk)
                for (verdict in verdicts) {
                    if (!verdict.matched) continue
                    val call = chunk.firstOrNull {
                        it.phone == verdict.phone && it.startedAt == verdict.startedAt
                    } ?: continue
                    // A replayed call is not news: count only fresh rows.
                    if (store.rememberMatched(call.phone, call.startedAt, call.durationSec)) {
                        store.sentCalls = store.sentCalls + 1
                    }
                }
                store.lastLogAt = maxOf(store.lastLogAt, chunk.last().startedAt)
            }

            // 2. Recordings for matched calls. MIUI/Samsung close the file at
            //    hang-up but folders can index late — a call with no file yet
            //    simply stays pending for a later cycle. Counters go to the
            //    screen (v1.1): a silent audio pass was undebuggable — zero
            //    uploads and nothing anywhere to say why.
            var found = 0
            var sent = 0
            var refused = 0
            val pendings = store.pendingAudio(AUDIO_PER_CYCLE)
            for (pending in pendings) {
                val rec = Recordings.findFor(context, pending.phone, pending.startedAt, pending.durationSec)
                if (rec == null) {
                    if (now - pending.startedAt > AUDIO_WAIT_MS) {
                        store.markAudio(pending.phone, pending.startedAt, Store.AUDIO_EXPIRED)
                    }
                    continue
                }
                found += 1
                val stream = rec.open(context)
                if (stream == null) {
                    // Visible but unreadable: leave it pending — the counters
                    // will show found > sent and name the problem.
                    continue
                }
                try {
                    Api.uploadAudio(store.server, token, rec.name, stream, pending.phone, pending.startedAt)
                    store.markAudio(pending.phone, pending.startedAt, Store.AUDIO_SENT)
                    store.sentAudio = store.sentAudio + 1
                    sent += 1
                } catch (r: AudioRefused) {
                    // Final for THIS file — retrying re-sends megabytes for ever.
                    store.markAudio(pending.phone, pending.startedAt, Store.AUDIO_REFUSED)
                    refused += 1
                }
            }
            // media:N = call recordings MediaStore shows for the last 24 h —
            // splits «no access» from «no file for THAT call» at a glance.
            store.audioStatus =
                "${pendings.size}/${found}/${sent}/${refused} · media:${Recordings.visibleRecent(context)}"

            store.prune(now)
            store.lastSyncAt = now
            store.lastError = ""
            return Outcome.OK
        } catch (revoked: Revoked) {
            // /profile said stop. Forget everything — 410 is an answer, not
            // an outage (#289's rule from the driver fleet).
            store.clearAll()
            Schedule.cancelAll(context)
            store.lastError = "revoked"
            return Outcome.REVOKED
        } catch (err: Exception) {
            // Offline or a server hiccup: the watermark did not advance past
            // anything unsent, the next cycle repeats.
            store.lastError = err.message ?: "network"
            return Outcome.OFFLINE
        }
    }
}
