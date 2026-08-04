package uz.gsr.driver

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context

/**
 * The trip schedule lives in JobScheduler, not in the app.
 *
 * v1.2 kept it in AlarmManager: the service armed the next alarm at the end
 * of each cycle. That chain has a single link — when an alarm fires while
 * Android refuses to start the service (a killed process on a phone whose
 * battery settings were not all done), the alarm is consumed, nobody arms
 * the next one, and tracking is dead until a person opens the app. That is
 * exactly a truck going silent two hours after leaving: the first
 * unattended tick was the first broken link.
 *
 * A persisted periodic job has no link to break. The system re-runs it every
 * interval for as long as the app is installed, across reboots, whatever any
 * single run managed to do. The job is only the metronome — the service
 * still does the work.
 */
object Schedule {

    private const val PERIODIC_JOB = 1
    private const val EXTRA_JOB = 2

    /** No fix this cycle (tunnel, ferry, garage): retry soon, not in 2 h. */
    const val RETRY_MS = 10 * 60_000L

    private fun scheduler(context: Context): JobScheduler =
        context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler

    private fun component(context: Context) = ComponentName(context, TrackJob::class.java)

    /**
     * Make sure the periodic job exists with the wanted interval. Re-posting
     * a periodic job resets its phase (the next run moves a whole period
     * away), so an unchanged job is left strictly alone — every place that
     * merely wants to be sure tracking is alive calls this freely.
     */
    fun ensure(context: Context, store: Store) {
        if (!store.isPaired) return
        val wanted = store.intervalMinutes * 60_000L
        val existing = runCatching { scheduler(context).getPendingJob(PERIODIC_JOB) }.getOrNull()
        if (existing != null && existing.intervalMillis == wanted) return
        runCatching {
            scheduler(context).schedule(
                JobInfo.Builder(PERIODIC_JOB, component(context))
                    // Deliberately no network/charging constraints: a cycle
                    // with no internet still takes the fix into the queue —
                    // on this corridor dead zones are the norm, not the
                    // exception.
                    .setPeriodic(wanted)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    /** One extra run soon (missed fix, fresh boot) without touching the period. */
    fun soon(context: Context, delayMs: Long) {
        runCatching {
            scheduler(context).schedule(
                JobInfo.Builder(EXTRA_JOB, component(context))
                    .setMinimumLatency(delayMs.coerceAtLeast(1_000L))
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
