package uz.gsr.driver

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors

/**
 * Reports the truck's position a few times a day and DOES NOT EXIST in
 * between.
 *
 * The first release kept the GPS registered permanently; the owner asked for
 * the opposite trade — a position every 2-3 hours is all the logist needs and
 * the driver's battery has to survive a six-day run. v1.3 takes the same idea
 * one step further: the service only lives for the length of one cycle (wake,
 * one fix, upload, stop), so its notification exists for a minute or two
 * every couple of hours instead of sitting in the shade all trip — the
 * closest Android allows to the owner's «telda yo'qdek bo'lsin». The clock
 * that wakes it is a persisted periodic job (see Schedule), not an alarm the
 * service has to keep re-arming itself.
 *
 * Uses the plain framework LocationManager rather than Google's fused
 * provider on purpose: many Chinese phones (Huawei above all) ship without
 * Google Play services, and the app has to work on the driver's own phone,
 * whatever it is.
 */
class TrackingService : Service() {

    companion object {
        /**
         * The first release used IMPORTANCE_LOW on "gsr_tracking". Android
         * never lowers the importance of an existing channel, so the quiet
         * notification the owner asked for needs a new channel id.
         */
        const val CHANNEL_ID = "gsr_tracking_v2"
        private const val LEGACY_CHANNEL_ID = "gsr_tracking"
        const val NOTIFICATION_ID = 42

        const val ACTION_TICK = "uz.gsr.driver.action.TICK"
        const val ACTION_SEND_NOW = "uz.gsr.driver.action.SEND_NOW"

        /** How long the GPS stays on while waiting for a usable fix. */
        private const val FIX_WINDOW_MS = 90_000L
        /** Accurate enough to stop waiting and switch the radio off early. */
        private const val GOOD_ACCURACY_M = 100f
        /** Quick retries in a row before falling back to the normal cadence. */
        private const val MISS_RETRY_MAX = 3
        private const val WAKE_TIMEOUT_MS = 3 * 60_000L
        /** Only mention the queue once a real backlog has piled up. */
        private const val BACKLOG_WARN = 12

        fun start(context: Context) {
            startWith(context, null)
        }

        fun sendNow(context: Context) {
            startWith(context, ACTION_SEND_NOW)
        }

        /**
         * A cycle start that reports whether Android allowed it — the job's
         * fallback hangs off the answer.
         */
        fun tryStart(context: Context): Boolean = startWith(context, ACTION_TICK)

        fun stop(context: Context) {
            Schedule.cancelAll(context)
            runCatching { context.stopService(Intent(context, TrackingService::class.java)) }
        }

        private fun startWith(context: Context, action: String?): Boolean {
            val intent = Intent(context, TrackingService::class.java)
            if (action != null) intent.action = action
            // A plain start works whenever the app is visible or the service
            // is already up; startForegroundService is the cold-start path
            // from a background job — which Android 12+ allows because the
            // setup screen has the app taken off battery optimisations.
            if (runCatching { context.startService(intent) }.isSuccess) return true
            return runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }.onFailure { err -> Log.w("GSRDriver", "start: ${err.message}") }.isSuccess
        }
    }

    private lateinit var store: Store
    private val handler = Handler(Looper.getMainLooper())
    private val network = Executors.newSingleThreadExecutor()

    @Volatile private var flushing = false
    @Volatile private var destroyed = false
    private var acquiring = false
    private var lastStartId = 0
    private var best: Location? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFix(location)

        // Older Android versions call these; keep them harmless.
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

        override fun onProviderEnabled(provider: String) = Unit

        override fun onProviderDisabled(provider: String) = Unit
    }

    private val fixWindowElapsed = Runnable { finishCycle() }

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        createChannel()
        startInForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        if (!store.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_TICK, ACTION_SEND_NOW -> startCycle()
            else -> {
                // A restart after the OS killed us mid-cycle (START_STICKY
                // hands back a null intent), or an activity poke. `nextTickAt`
                // is only set at the END of a cycle, so an unset/past value
                // means one is genuinely due — including the very first one.
                // Anything else has nothing to do here: the schedule lives in
                // JobScheduler, and an idle foreground service would keep a
                // notification up for no reason.
                if (store.nextTickAt <= System.currentTimeMillis()) {
                    startCycle()
                } else {
                    endCycleIfIdle()
                }
            }
        }
        // Finish an interrupted cycle if Android kills us mid-way.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        destroyed = true
        handler.removeCallbacksAndMessages(null)
        stopListening()
        releaseWake(force = true)
        network.shutdown()
        // Belt for the in-flight drain's late post: once the service is gone
        // its notification must be too, whoever re-posted it.
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(NOTIFICATION_ID)
        }
        super.onDestroy()
    }

    // --- Cycle -------------------------------------------------------------

    private fun startCycle() {
        if (acquiring) return
        holdWake()
        // Always drain the queue, fix or no fix: this is also how a phone that
        // spent two days out of coverage catches up.
        flush()
        acquireFix()
    }

    private fun hasLocationPermission(): Boolean =
        ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    // The permission IS checked one line below; lint cannot see through it.
    @SuppressLint("MissingPermission")
    private fun acquireFix() {
        if (!hasLocationPermission()) {
            finishCycle(hopeless = true)
            return
        }
        val manager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        best = null
        var registered = false
        // Ask every provider the phone actually has; the network provider
        // keeps working in tunnels and dense city blocks where GPS drops.
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            runCatching {
                if (manager.isProviderEnabled(provider)) {
                    manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                    registered = true
                }
            }.onFailure { Log.w("GSRDriver", "provider $provider: ${it.message}") }
        }
        if (!registered) {
            finishCycle(hopeless = true)
            return
        }
        acquiring = true
        handler.postDelayed(fixWindowElapsed, FIX_WINDOW_MS)
    }

    private fun accuracyOf(location: Location): Float =
        if (location.hasAccuracy()) location.accuracy else 9_999f

    private fun onFix(location: Location) {
        val current = best
        if (current == null || accuracyOf(location) <= accuracyOf(current)) best = location
        // Good enough — no reason to burn the radio for the rest of the window.
        if (accuracyOf(location) <= GOOD_ACCURACY_M) finishCycle()
    }

    private fun stopListening() {
        acquiring = false
        handler.removeCallbacks(fixWindowElapsed)
        runCatching {
            (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(listener)
        }
    }

    /** `hopeless`: no permission or no providers — nothing a retry can heal. */
    private fun finishCycle(hopeless: Boolean = false) {
        val wasAcquiring = acquiring
        stopListening()
        val fix = best
        best = null
        if (fix != null) {
            val recordedAt = if (fix.time > 0) fix.time else System.currentTimeMillis()
            val accuracy = accuracyOf(fix)
            store.enqueue(
                lat = fix.latitude,
                lon = fix.longitude,
                accuracy = if (accuracy >= 9_999f) 0f else accuracy,
                // m/s → km/h, the unit the server stores.
                speed = if (fix.hasSpeed()) fix.speed * 3.6f else 0f,
                recordedAt = recordedAt,
            )
            store.rememberFix(fix.latitude, fix.longitude, recordedAt)
            store.missStreak = 0
            flush()
        }
        // A tunnel heals, so a missed WINDOW retries soon — but only a few in
        // a row: a phone that listens and hears nothing for half an hour is
        // not in a tunnel, and an every-10-minutes GPS window would eat the
        // battery this whole schedule exists to protect. A hopeless miss
        // (permission revoked, location switched off) never retries early —
        // waking every 10 minutes cannot fix what only a person can.
        var delayMs = store.intervalMinutes * 60_000L
        if (fix == null && wasAcquiring && !hopeless) {
            val streak = store.missStreak + 1
            store.missStreak = streak
            if (streak <= MISS_RETRY_MAX) {
                delayMs = Schedule.RETRY_MS
                Schedule.soon(this, Schedule.RETRY_MS)
            }
        }
        // An estimate for the status screen (JobScheduler owns the real time),
        // and the dedupe that stops a repeated poke becoming a reporting loop.
        store.nextTickAt = System.currentTimeMillis() + delayMs
        updateNotification()
        endCycleIfIdle()
    }

    /**
     * The cycle is over when neither the GPS nor the upload is running — then
     * the service stops and takes its notification with it. The next run is
     * JobScheduler's problem, which is the point: nothing that happens to
     * THIS process can lose the schedule.
     */
    private fun endCycleIfIdle() {
        if (acquiring || flushing) return
        releaseWake(force = true)
        // stopSelf(startId), never plain stopSelf(): if a newer start — the
        // next tick, a «Hozir yuborish» press — was accepted but not yet
        // delivered, this stop is refused and the service lives to run it.
        // A plain stopSelf() swallows that start with the instance, which is
        // the v1.2 silent-gap shape all over again, just rarer.
        stopSelf(lastStartId)
    }

    // --- Wake lock ---------------------------------------------------------

    /**
     * The job only guarantees a few seconds of CPU. Waiting up to 90 s for a
     * GPS fix and then uploading needs the CPU awake for longer, so the cycle
     * holds a partial wake lock — with a hard timeout, so it can never leak.
     */
    private fun holdWake() {
        if (wakeLock?.isHeld == true) return
        runCatching {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gsr:driver-cycle")
            lock.setReferenceCounted(false)
            lock.acquire(WAKE_TIMEOUT_MS)
            wakeLock = lock
        }.onFailure { Log.w("GSRDriver", "wakelock: ${it.message}") }
    }

    private fun releaseWake(force: Boolean = false) {
        if (!force && (acquiring || flushing)) return
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
    }

    // --- Upload ------------------------------------------------------------

    private fun flush() {
        if (flushing) return
        flushing = true
        network.execute {
            // Nothing may escape this executor: an uncaught throw on a bare
            // thread kills the PROCESS, and with a persisted schedule that
            // replays every interval, a full disk would become a crash loop.
            val outcome = runCatching { Uploader.drain(store) }
                .getOrDefault(Uploader.Outcome.ERROR)
            flushing = false
            handler.post {
                // The service can be destroyed while the drain is in flight
                // (the stop button, a trip end). A late notify() here would
                // re-post the notification as an ordinary ongoing one that
                // nothing left alive could ever remove.
                if (destroyed) return@post
                if (outcome == Uploader.Outcome.FINISHED) {
                    Schedule.cancelAll(this)
                    store.clearTrip()
                    stopListening()
                    releaseWake(force = true)
                    stopSelf()
                } else {
                    updateNotification()
                    endCycleIfIdle()
                }
            }
        }
    }

    // --- Notification ------------------------------------------------------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        runCatching { manager.deleteNotificationChannel(LEGACY_CHANNEL_ID) }
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_MIN,
        )
        channel.setShowBadge(false)
        channel.enableVibration(false)
        channel.setSound(null, null)
        manager.createNotificationChannel(channel)
    }

    /** Null while everything is fine — silence is the normal state. */
    private fun problemText(): String? {
        if (!hasLocationPermission()) return getString(R.string.notify_no_permission)
        val queued = runCatching { store.pendingCount() }.getOrDefault(0)
        if (queued >= BACKLOG_WARN) return getString(R.string.notify_backlog, queued)
        return null
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(
                if (store.tripLabel.isEmpty()) {
                    getString(R.string.app_name)
                } else {
                    getString(R.string.notification_title, store.tripLabel)
                }
            )
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_MIN)
        // The driver should not get a "sent" message every couple of hours
        // (owner's request) — the notification only speaks up about problems.
        val text = problemText()
        if (text != null) builder.setContentText(text)
        return builder.build()
    }

    /**
     * Failure is survivable here: on Android 14+ a location-type foreground
     * start throws if the location permission was revoked mid-trip. The
     * cycle still runs in the background then — the upload half works, and
     * the job's next run tries again.
     */
    private fun startInForeground() {
        runCatching {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        }.onFailure { Log.w("GSRDriver", "foreground: ${it.message}") }
    }

    private fun updateNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { manager.notify(NOTIFICATION_ID, buildNotification()) }
    }
}
