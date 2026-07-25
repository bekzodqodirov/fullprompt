package uz.gsr.driver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Wakes the service for one position report.
 *
 * The clock lives in AlarmManager rather than in the service itself because a
 * phone in Doze suspends the CPU between alarms — which is exactly what makes
 * the every-2-hours schedule cheap on battery.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (!Store(context).isPaired) return
        TrackingService.tick(context)
    }
}
