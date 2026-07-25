package uz.gsr.driver

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
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
 * Reports the truck's position a few times a day and sleeps in between.
 *
 * The first release kept the GPS registered permanently; the owner asked for
 * the opposite trade — a position every 2-3 hours is all the logist needs and
 * the driver's battery has to survive a six-day run. So the service now wakes
 * on an alarm, takes ONE fix, uploads, and lets the radio go back to sleep.
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
        /** No fix this cycle (tunnel, ferry, garage): retry soon, not in 2 h. */
        private const val RETRY_MS = 10 * 60_000L
        private const val WAKE_TIMEOUT_MS = 3 * 60_000L
        private const val BATCH_SIZE = 200
        /** Only mention the queue once a real backlog has piled up. */
        private const val BACKLOG_WARN = 12

        fun start(context: Context) = send(context, null)

        fun tick(context: Context) = send(context, ACTION_TICK)

        fun sendNow(context: Context) = send(context, ACTION_SEND_NOW)

        fun stop(context: Context) {
            cancelAlarm(context)
            runCatching { context.stopService(Intent(context, TrackingService::class.java)) }
        }

        private fun send(context: Context, action: String?) {
            val intent = Intent(context, TrackingService::class.java)
            if (action != null) intent.action = action
            // While the service is already running in the foreground a plain
            // start is enough and never trips Android 12's background-start
            // rules; startForegroundService is the fallback for a cold start.
            runCatching { context.startService(intent) }.onFailure {
                runCatching {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        context.startForegroundService(intent)
                    } else {
                        context.startService(intent)
                    }
                }.onFailure { err -> Log.w("GSRDriver", "start: ${err.message}") }
            }
        }

        private fun alarmIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context,
            7,
            Intent(context, AlarmReceiver::class.java).setAction(ACTION_TICK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun cancelAlarm(context: Context) {
            runCatching {
                (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
                    .cancel(alarmIntent(context))
            }
        }
    }

    private lateinit var store: Store
    private val handler = Handler(Looper.getMainLooper())
    private val network = Executors.newSingleThreadExecutor()

    @Volatile private var flushing = false
    private var acquiring = false
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
        if (!store.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_TICK, ACTION_SEND_NOW -> startCycle()
            else -> {
                // Fresh start, or a restart after the OS killed us. Report at
                // once when nothing has ever been sent (the warehouse worker
                // must see the first dot appear) or when the alarm is overdue;
                // otherwise just make sure the alarm is armed.
                if (store.lastFixAt == 0L || store.nextTickAt <= System.currentTimeMillis()) {
                    startCycle()
                } else {
                    scheduleNext(store.nextTickAt - System.currentTimeMillis())
                    updateNotification()
                }
            }
        }
        // Restart if Android kills us (aggressive Chinese OEM battery savers).
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopListening()
        releaseWake(force = true)
        network.shutdown()
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
            finishCycle(retry = true)
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
            finishCycle(retry = true)
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

    private fun finishCycle(retry: Boolean = false) {
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
            flush()
        }
        val missed = fix == null && (retry || wasAcquiring)
        scheduleNext(if (missed) RETRY_MS else store.intervalMinutes * 60_000L)
        updateNotification()
        releaseWake()
    }

    private fun scheduleNext(delayMs: Long) {
        val at = System.currentTimeMillis() + delayMs.coerceAtLeast(60_000L)
        store.nextTickAt = at
        runCatching {
            val alarms = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            // Inexact on purpose: setExactAndAllowWhileIdle needs a restricted
            // permission and a truck does not care about ±10 minutes. Once the
            // app is off the battery-optimisation list this fires on time.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarmIntent(this))
        }.onFailure { Log.w("GSRDriver", "alarm: ${it.message}") }
    }

    // --- Wake lock ---------------------------------------------------------

    /**
     * The alarm only guarantees a few seconds of CPU. Waiting up to 90 s for a
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
        val token = store.token ?: return
        if (flushing) return
        flushing = true
        network.execute {
            try {
                while (true) {
                    val batch = store.pending(BATCH_SIZE)
                    if (batch.isEmpty()) break
                    Api.upload(store.server, token, batch)
                    store.delete(batch)
                    store.lastSentAt = System.currentTimeMillis()
                    store.lastError = ""
                }
            } catch (finished: TripFinished) {
                store.clearTrip()
                handler.post {
                    cancelAlarm(this)
                    updateNotification(getString(R.string.status_trip_finished))
                    stopSelf()
                }
            } catch (err: Exception) {
                // Offline or server hiccup: the queue keeps everything and the
                // next cycle tries again.
                store.lastError = err.message ?: "network"
            } finally {
                flushing = false
                handler.post {
                    releaseWake()
                    updateNotification()
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

    private fun buildNotification(override: String?): Notification {
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
        val text = override ?: problemText()
        if (text != null) builder.setContentText(text)
        return builder.build()
    }

    private fun startInForeground() {
        val notification = buildNotification(null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(override: String? = null) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { manager.notify(NOTIFICATION_ID, buildNotification(override)) }
    }
}
