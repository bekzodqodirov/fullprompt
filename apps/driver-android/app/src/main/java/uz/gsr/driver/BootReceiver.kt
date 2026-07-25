package uz.gsr.driver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * A truck gets switched off and restarted many times during a six-day run,
 * and phones get rebooted with it. Tracking must come back by itself — the
 * driver is not expected to remember to open anything.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        if (Store(context).isPaired) TrackingService.start(context)
    }
}
