package uz.gsr.driver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * A truck gets switched off and restarted many times during a six-day run,
 * and phones get rebooted with it. Tracking must come back by itself — the
 * driver is not expected to remember to open anything.
 *
 * The persisted periodic job survives a reboot on its own; this receiver is
 * for coming back QUICKLY (the next periodic slot could be two hours away)
 * and for an install that was still on the old alarm design when it was
 * updated. It only touches JobScheduler — starting a location service
 * straight from a boot broadcast is exactly the kind of thing newer Android
 * versions keep adding rules about, and the job arrives within a minute
 * anyway.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        val store = Store(context)
        if (!store.isPaired) return
        Schedule.ensure(context, store)
        Schedule.soon(context, 60_000L)
    }
}
