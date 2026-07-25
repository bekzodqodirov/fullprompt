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
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors

/**
 * Keeps reporting with the screen off and the phone in the driver's pocket.
 *
 * Uses the plain framework LocationManager rather than Google's fused
 * provider on purpose: many Chinese phones (Huawei above all) ship without
 * Google Play services, and the app has to work on the driver's own phone,
 * whatever it is.
 */
class TrackingService : Service(), LocationListener {

    companion object {
        const val CHANNEL_ID = "gsr_tracking"
        const val NOTIFICATION_ID = 42
        /** A fix at most every 5 minutes is plenty for a 6-day truck run. */
        private const val MIN_INTERVAL_MS = 5 * 60_000L
        private const val MIN_DISTANCE_M = 250f
        private const val FLUSH_INTERVAL_MS = 5 * 60_000L
        private const val BATCH_SIZE = 200

        fun start(context: Context) {
            val intent = Intent(context, TrackingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TrackingService::class.java))
        }
    }

    private lateinit var store: Store
    private val handler = Handler(Looper.getMainLooper())
    private val network = Executors.newSingleThreadExecutor()
    @Volatile private var flushing = false

    private val flushTick = object : Runnable {
        override fun run() {
            flush()
            handler.postDelayed(this, FLUSH_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        createChannel()
        startInForeground(getString(R.string.status_starting))
        requestLocation()
        handler.postDelayed(flushTick, 30_000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Restart if Android kills us (aggressive Chinese OEM battery savers).
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        runCatching {
            (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(this)
        }
        network.shutdown()
        super.onDestroy()
    }

    // --- Location ----------------------------------------------------------

    private fun hasLocationPermission(): Boolean =
        ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    // The permission IS checked one line below; lint cannot see through it.
    @SuppressLint("MissingPermission")
    private fun requestLocation() {
        if (!hasLocationPermission()) {
            updateNotification(getString(R.string.status_no_permission))
            return
        }
        val manager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        // Ask every provider the phone actually has; the network provider
        // keeps working in tunnels and dense city blocks where GPS drops.
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            runCatching {
                if (manager.isProviderEnabled(provider)) {
                    manager.requestLocationUpdates(
                        provider,
                        MIN_INTERVAL_MS,
                        MIN_DISTANCE_M,
                        this,
                        Looper.getMainLooper(),
                    )
                }
            }.onFailure { Log.w("GSRDriver", "provider $provider: ${it.message}") }
        }
    }

    override fun onLocationChanged(location: Location) {
        store.enqueue(
            lat = location.latitude,
            lon = location.longitude,
            accuracy = if (location.hasAccuracy()) location.accuracy else 0f,
            // m/s → km/h, the unit the server stores.
            speed = if (location.hasSpeed()) location.speed * 3.6f else 0f,
            recordedAt = if (location.time > 0) location.time else System.currentTimeMillis(),
        )
        updateNotification(statusText())
        flush()
    }

    // Older Android versions call these; keep them harmless.
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    override fun onProviderEnabled(provider: String) {
        requestLocation()
    }

    override fun onProviderDisabled(provider: String) = Unit

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
                    updateNotification(getString(R.string.status_trip_finished))
                    stopSelf()
                }
            } catch (err: Exception) {
                // Offline or server hiccup: the queue keeps everything and the
                // next tick tries again.
                store.lastError = err.message ?: "network"
            } finally {
                flushing = false
                handler.post { updateNotification(statusText()) }
            }
        }
    }

    private fun statusText(): String {
        val queued = store.pendingCount()
        return if (queued > 0) {
            getString(R.string.status_queued, queued)
        } else {
            getString(R.string.status_sent)
        }
    }

    // --- Notification ------------------------------------------------------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.setShowBadge(false)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(
                if (store.tripLabel.isEmpty()) {
                    getString(R.string.app_name)
                } else {
                    getString(R.string.notification_title, store.tripLabel)
                }
            )
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun startInForeground(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { manager.notify(NOTIFICATION_ID, buildNotification(text)) }
    }
}
