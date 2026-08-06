package uz.gsr.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Phones get rebooted; the sync must come back by itself. The persisted job
 * survives a reboot on its own — this receiver is for coming back QUICKLY
 * and for picking up after an update. It only touches JobScheduler.
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
