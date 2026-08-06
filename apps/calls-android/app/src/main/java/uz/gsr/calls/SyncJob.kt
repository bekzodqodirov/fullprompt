package uz.gsr.calls

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.Executors

/**
 * One scheduled run = one sync cycle, on a worker thread.
 *
 * No foreground service and no notification: the cycle reads two lists and
 * posts JSON, well inside a job's execution window — the driver app needed
 * a service only because GPS demands the foreground. Nothing may escape the
 * executor: an uncaught throw on a bare thread kills the process, and the
 * persisted schedule would replay the crash every interval.
 */
class SyncJob : JobService() {

    private val io = Executors.newSingleThreadExecutor()

    override fun onStartJob(params: JobParameters): Boolean {
        val store = Store(this)
        if (!store.isPaired) {
            Schedule.cancelAll(this)
            return false
        }
        io.execute {
            try {
                runCatching { Sync.cycle(this, store) }
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }
}
