package uz.gsr.driver

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * The two phone settings that decide whether tracking survives the trip.
 *
 * Neither is a normal runtime permission: battery optimisation is a system
 * dialog, and the OEM auto-start whitelist is a vendor screen with no API at
 * all. Both are the usual reason a truck goes silent on day two, so the setup
 * screen walks the warehouse worker through them.
 */
object Setup {

    /** True once Android stops putting the app to sleep in the background. */
    fun batteryUnrestricted(context: Context): Boolean = runCatching {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        power.isIgnoringBatteryOptimizations(context.packageName)
    }.getOrDefault(false)

    /**
     * The system "allow this app to run in the background?" dialog. Falls back
     * to the battery-optimisation list, then to the app's settings page, since
     * a few OEM builds ship without the direct dialog.
     */
    fun batteryIntents(context: Context): List<Intent> = listOf(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}")),
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        appDetails(context),
    )

    /**
     * Vendor auto-start screens. Chinese skins kill background apps unless the
     * app is on this list, and there is no way to read or request it — the
     * worker has to switch it on by hand, so the app just opens the screen.
     */
    fun autostartIntents(context: Context): List<Intent> {
        val components = listOf(
            // Xiaomi / Redmi / POCO
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            // Huawei / Honor
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            // Oppo / Realme
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            // Vivo / iQOO
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            // Letv, Asus
            "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
            "com.asus.mobilemanager" to "com.asus.mobilemanager.autostart.AutoStartActivity",
        )
        return components.map { (pkg, cls) ->
            Intent().setComponent(ComponentName(pkg, cls))
        } + appDetails(context)
    }

    fun appDetails(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${context.packageName}"))

    /**
     * Try each candidate until one of them actually opens. Deliberately no
     * resolveActivity() pre-check: from Android 11 package visibility hides
     * other vendors' components, so asking first says "missing" for screens
     * that are in fact there.
     */
    fun open(context: Context, candidates: List<Intent>): Boolean {
        for (intent in candidates) {
            if (runCatching { context.startActivity(intent) }.isSuccess) return true
        }
        return false
    }
}
