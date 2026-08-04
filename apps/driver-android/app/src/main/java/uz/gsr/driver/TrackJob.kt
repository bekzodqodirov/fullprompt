package uz.gsr.driver

import android.Manifest
import android.annotation.SuppressLint
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

/**
 * One scheduled run = one position cycle.
 *
 * The job's real work is to hand the cycle to TrackingService, which may keep
 * the GPS on for up to 90 s at full rate (a foreground service counts as
 * "foreground" for location). When Android refuses that start — battery
 * restrictions on a phone where a setup step was skipped — the job does the
 * best a background process is still allowed to do INSTEAD of doing nothing:
 * drains the upload queue and reports the last position some other app
 * computed. Degraded beats dead, and the next run tries the service again —
 * one refusal can no longer kill the schedule, which is the difference
 * between this design and the alarm chain it replaced.
 */
class TrackJob : JobService() {

    private val io = Executors.newSingleThreadExecutor()

    override fun onStartJob(params: JobParameters): Boolean {
        val store = Store(this)
        if (!store.isPaired) {
            // Unpaired but still scheduled: a leftover — tidy up and stop.
            Schedule.cancelAll(this)
            return false
        }
        if (TrackingService.tryStart(this)) return false // the service carries on alone
        io.execute {
            try {
                // Nothing may escape this executor: an uncaught throw on a
                // bare thread kills the process, and the persisted schedule
                // would replay the crash every interval.
                runCatching { fallbackCycle(store) }
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

    /** What a background process may still do when the service start is refused. */
    private fun fallbackCycle(store: Store) {
        // The status screen's estimate. Degraded mode still reports once per
        // interval, and without this the screen would read «hozir» for the
        // whole trip on exactly the phones running degraded.
        store.nextTickAt = System.currentTimeMillis() + store.intervalMinutes * 60_000L
        val last = lastKnown()
        if (last != null && last.time > 0 && last.time > store.lastFixAt) {
            store.enqueue(
                lat = last.latitude,
                lon = last.longitude,
                accuracy = if (last.hasAccuracy()) last.accuracy else 0f,
                speed = if (last.hasSpeed()) last.speed * 3.6f else 0f,
                recordedAt = last.time,
            )
            store.rememberFix(last.latitude, last.longitude, last.time)
        }
        when (Uploader.drain(store)) {
            Uploader.Outcome.FINISHED -> {
                Schedule.cancelAll(this)
                store.clearTrip()
            }
            else -> Unit
        }
    }

    // The permission IS checked first; lint cannot see through the flags.
    @SuppressLint("MissingPermission")
    private fun lastKnown(): Location? {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return null
        val manager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var best: Location? = null
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        for (provider in providers) {
            val candidate = runCatching { manager.getLastKnownLocation(provider) }.getOrNull() ?: continue
            val current = best
            if (current == null || candidate.time > current.time) best = candidate
        }
        return best
    }
}
