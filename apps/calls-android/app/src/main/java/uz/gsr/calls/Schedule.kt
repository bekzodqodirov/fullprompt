package uz.gsr.calls

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context

/**
 * The schedule lives in JobScheduler, not in the app — the driver fleet's
 * lesson: an alarm chain has a single link, a persisted periodic job has
 * none. The system re-runs it every interval for as long as the app is
 * installed, across reboots, whatever any single run managed to do.
 */
object Schedule {

    private const val PERIODIC_JOB = 1
    private const val EXTRA_JOB = 2

    private fun scheduler(context: Context): JobScheduler =
        context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler

    private fun component(context: Context) = ComponentName(context, SyncJob::class.java)

    /**
     * Make sure the periodic job exists. Re-posting a periodic job resets its
     * phase, so an existing job is left strictly alone — every place that
     * merely wants to be sure the sync is alive calls this freely.
     */
    fun ensure(context: Context, store: Store) {
        if (!store.isPaired) return
        if (runCatching { scheduler(context).getPendingJob(PERIODIC_JOB) }.getOrNull() != null) return
        runCatching {
            scheduler(context).schedule(
                JobInfo.Builder(PERIODIC_JOB, component(context))
                    .setPeriodic(Store.INTERVAL_MINUTES * 60_000L)
                    // Unlike the GPS queue, a cycle with no internet has
                    // nothing useful to do — let the system wait for one.
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    /** One extra run soon (fresh boot, fresh pairing). */
    fun soon(context: Context, delayMs: Long) {
        runCatching {
            scheduler(context).schedule(
                JobInfo.Builder(EXTRA_JOB, component(context))
                    .setMinimumLatency(delayMs.coerceAtLeast(1_000L))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    fun cancelAll(context: Context) {
        runCatching {
            scheduler(context).cancel(PERIODIC_JOB)
            scheduler(context).cancel(EXTRA_JOB)
        }
    }
}
