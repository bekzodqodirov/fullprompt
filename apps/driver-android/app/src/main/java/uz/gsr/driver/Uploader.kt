package uz.gsr.driver

/**
 * The one upload loop, shared by the service's cycle and the job's fallback.
 * Safe to run from anywhere: a batch is deleted from the queue only after the
 * server accepted it, and the server ignores duplicates from a re-flush.
 */
object Uploader {

    enum class Outcome {
        /** Nothing waiting (or no token). */
        EMPTY,

        /** Everything queued went out. */
        SENT,

        /** Offline or server hiccup — the queue keeps everything. */
        ERROR,

        /** The server said 410: the trip is over, the app must stop. */
        FINISHED,
    }

    private const val BATCH_SIZE = 200

    fun drain(store: Store): Outcome {
        val token = store.token ?: return Outcome.EMPTY
        var sent = false
        while (true) {
            val batch = runCatching { store.pending(BATCH_SIZE) }.getOrNull() ?: return Outcome.ERROR
            if (batch.isEmpty()) break
            try {
                Api.upload(store.server, token, batch)
                // The bookkeeping stays INSIDE the guard: on a full disk the
                // DELETE can throw after a successful send, and escaping here
                // would kill the process — which the persisted schedule then
                // replays every interval. Stopping with ERROR is safe: the
                // server ignores the re-upload next cycle.
                store.delete(batch)
                store.lastSentAt = System.currentTimeMillis()
                store.lastError = ""
            } catch (finished: TripFinished) {
                return Outcome.FINISHED
            } catch (err: Exception) {
                store.lastError = err.message ?: "network"
                return Outcome.ERROR
            }
            sent = true
        }
        return if (sent) Outcome.SENT else Outcome.EMPTY
    }
}
