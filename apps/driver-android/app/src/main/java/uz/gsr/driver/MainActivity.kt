package uz.gsr.driver

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Two screens in one: pairing (before the truck leaves) and trip status.
 *
 * The warehouse worker does the whole setup with the driver's phone in hand,
 * so the five things that have to be right — location, background location,
 * notifications, battery, vendor auto-start — are walked through one after
 * another and then kept on screen as a checklist that stays red until each
 * one is actually done.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val STEP_LOCATION = 1
        const val STEP_NOTIFY = 2
        const val STEP_BACKGROUND = 3
        const val STEP_BATTERY = 4
        const val STEP_AUTOSTART = 5
    }

    private lateinit var store: Store
    private val io = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    /** Steps already offered during this run of the chain — never nag twice. */
    private val asked = HashSet<Int>()
    private var chainActive = false

    private lateinit var pairPanel: View
    private lateinit var statusPanel: View
    private lateinit var serverInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var pairButton: Button
    private lateinit var stateText: TextView
    private lateinit var stateHint: TextView
    private lateinit var tripText: TextView
    private lateinit var setupCard: View
    private lateinit var textLocation: TextView
    private lateinit var textBackground: TextView
    private lateinit var textNotify: TextView
    private lateinit var textBattery: TextView
    private lateinit var textAutostart: TextView
    private lateinit var rowBackground: View
    private lateinit var rowNotify: View
    private lateinit var btnAutostartDone: Button
    private lateinit var intervalGroup: RadioGroup
    private lateinit var lastFixText: TextView
    private lateinit var nextTickText: TextView
    private lateinit var queueText: TextView
    private lateinit var errorText: TextView

    private val liveRefresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 5_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = Store(this)

        pairPanel = findViewById(R.id.pairPanel)
        statusPanel = findViewById(R.id.statusPanel)
        serverInput = findViewById(R.id.serverInput)
        codeInput = findViewById(R.id.codeInput)
        pairButton = findViewById(R.id.pairButton)
        stateText = findViewById(R.id.stateText)
        stateHint = findViewById(R.id.stateHint)
        tripText = findViewById(R.id.tripText)
        setupCard = findViewById(R.id.setupCard)
        textLocation = findViewById(R.id.textLocation)
        textBackground = findViewById(R.id.textBackground)
        textNotify = findViewById(R.id.textNotify)
        textBattery = findViewById(R.id.textBattery)
        textAutostart = findViewById(R.id.textAutostart)
        rowBackground = findViewById(R.id.rowBackground)
        rowNotify = findViewById(R.id.rowNotify)
        btnAutostartDone = findViewById(R.id.btnAutostartDone)
        intervalGroup = findViewById(R.id.intervalGroup)
        lastFixText = findViewById(R.id.lastFixText)
        nextTickText = findViewById(R.id.nextTickText)
        queueText = findViewById(R.id.queueText)
        errorText = findViewById(R.id.errorText)

        serverInput.setText(store.server)
        // Two builds look the same on a phone: say out loud which one this is.
        findViewById<TextView>(R.id.versionText).text = getString(
            R.string.app_version,
            getString(R.string.app_tagline),
            BuildConfig.VERSION_NAME,
            BuildConfig.BUILD_ID,
        )
        pairButton.setOnClickListener { pair() }

        // Every red row offers the same escape hatch: restart the chain from
        // the first thing that is still missing.
        for (id in intArrayOf(R.id.btnLocation, R.id.btnBackground, R.id.btnNotify, R.id.btnBattery)) {
            findViewById<Button>(id).setOnClickListener { runChain() }
        }
        findViewById<Button>(R.id.btnAutostart).setOnClickListener { openAutostart() }
        btnAutostartDone.setOnClickListener {
            store.autostartConfirmed = true
            render()
        }
        findViewById<Button>(R.id.sendNowButton).setOnClickListener {
            TrackingService.sendNow(this)
            toast(getString(R.string.sending))
        }
        findViewById<Button>(R.id.stopButton).setOnClickListener { stopTrip() }

        intervalGroup.setOnCheckedChangeListener { _, checkedId ->
            val minutes = intervalFor(checkedId)
            if (minutes != store.intervalMinutes) {
                store.intervalMinutes = minutes
                // Re-arm right away so the screen shows the new schedule.
                if (store.isPaired) TrackingService.sendNow(this)
            }
        }

        render()
    }

    override fun onResume() {
        super.onResume()
        if (chainActive) step() else render()
        startTrackingIfReady()
        handler.removeCallbacks(liveRefresh)
        handler.postDelayed(liveRefresh, 5_000)
    }

    override fun onPause() {
        handler.removeCallbacks(liveRefresh)
        super.onPause()
    }

    // --- Pairing -----------------------------------------------------------

    private fun pair() {
        val server = serverInput.text.toString().trim().trimEnd('/')
        val code = codeInput.text.toString().trim()
        if (server.isEmpty() || code.length < 4) {
            toast(getString(R.string.error_fill_both))
            return
        }
        pairButton.isEnabled = false
        pairButton.text = getString(R.string.pairing)
        io.execute {
            try {
                val result = Api.pair(server, code)
                store.server = server
                store.token = result.token
                store.tripLabel = listOfNotNull(result.batchCode, result.driverName)
                    .filter { it.isNotEmpty() }
                    .joinToString(" · ")
                runOnUiThread {
                    codeInput.setText("")
                    toast(getString(R.string.paired))
                    runChain()
                }
            } catch (err: Exception) {
                runOnUiThread { toast(err.message ?: getString(R.string.error_pair)) }
            } finally {
                runOnUiThread {
                    pairButton.isEnabled = true
                    pairButton.text = getString(R.string.pair)
                }
            }
        }
    }

    private fun stopTrip() {
        TrackingService.stop(this)
        store.clearTrip()
        render()
    }

    // --- Setup chain -------------------------------------------------------

    private fun hasForegroundLocation(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasBackgroundLocation(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED

    private fun hasNotifications(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun nextMissingStep(): Int? = when {
        !hasForegroundLocation() -> STEP_LOCATION
        !hasNotifications() -> STEP_NOTIFY
        !hasBackgroundLocation() -> STEP_BACKGROUND
        !Setup.batteryUnrestricted(this) -> STEP_BATTERY
        !store.autostartConfirmed -> STEP_AUTOSTART
        else -> null
    }

    private fun runChain() {
        asked.clear()
        chainActive = true
        step()
    }

    /**
     * Android insists the background grant is asked for SEPARATELY, after the
     * foreground one is already given, and the battery dialog comes back
     * through onResume rather than a result callback — so the chain walks one
     * step at a time and stops as soon as a step it already offered is still
     * not satisfied (otherwise a refusal would loop forever).
     */
    private fun step() {
        if (!chainActive) return
        val next = nextMissingStep()
        if (next == null) {
            chainActive = false
            asked.clear()
            startTrackingIfReady()
            render()
            return
        }
        if (!asked.add(next)) {
            chainActive = false
            render()
            return
        }
        when (next) {
            STEP_LOCATION -> ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
                STEP_LOCATION,
            )

            STEP_NOTIFY -> ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                STEP_NOTIFY,
            )

            STEP_BACKGROUND -> {
                toast(getString(R.string.background_hint))
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
                    STEP_BACKGROUND,
                )
            }

            // Not a runtime permission but a system dialog: the app is put on
            // Android's allowlist, which is also what lets the 2-hour alarm
            // fire on time in Doze.
            STEP_BATTERY -> {
                toast(getString(R.string.battery_prompt))
                if (!Setup.open(this, Setup.batteryIntents(this))) {
                    toast(getString(R.string.error_settings))
                    chainActive = false
                }
            }

            STEP_AUTOSTART -> openAutostart()
        }
        render()
    }

    private fun openAutostart() {
        toast(getString(R.string.autostart_prompt))
        if (!Setup.open(this, Setup.autostartIntents(this))) {
            toast(getString(R.string.error_settings))
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        step()
    }

    private fun startTrackingIfReady() {
        if (store.isPaired && hasForegroundLocation()) TrackingService.start(this)
    }

    // --- Rendering ---------------------------------------------------------

    private fun render() {
        val paired = store.isPaired
        pairPanel.visibility = if (paired) View.GONE else View.VISIBLE
        statusPanel.visibility = if (paired) View.VISIBLE else View.GONE
        if (!paired) return

        tripText.text = store.tripLabel.ifEmpty { getString(R.string.trip_active) }
        renderChecklist()
        renderInterval()
        renderTiming()
        // Deliberately no service start here: render() also runs on the 5 s
        // screen refresh, and poking the service that often would keep asking
        // it to report. Starting is tied to onResume and to the setup chain.
    }

    private fun renderChecklist() {
        val location = hasForegroundLocation()
        val background = hasBackgroundLocation()
        val notify = hasNotifications()
        val battery = Setup.batteryUnrestricted(this)
        val autostart = store.autostartConfirmed

        mark(textLocation, R.string.check_location, location)
        mark(textBackground, R.string.check_background, background)
        mark(textNotify, R.string.check_notify, notify)
        mark(textBattery, R.string.check_battery, battery)
        mark(textAutostart, R.string.check_autostart, autostart)
        btnAutostartDone.visibility = if (autostart) View.GONE else View.VISIBLE

        // Steps Android does not have on this version are not "missing".
        rowBackground.visibility =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) View.VISIBLE else View.GONE
        rowNotify.visibility =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) View.VISIBLE else View.GONE

        val ready = location && background && notify && battery && autostart
        setupCard.visibility = if (ready) View.GONE else View.VISIBLE
        stateText.text = getString(if (ready) R.string.state_ok else R.string.state_setup)
        stateText.setTextColor(
            ContextCompat.getColor(this, if (ready) R.color.ok else R.color.warn),
        )
        stateHint.text = getString(if (ready) R.string.state_hint_ok else R.string.state_hint_setup)
    }

    private fun mark(view: TextView, labelRes: Int, done: Boolean) {
        view.text = getString(if (done) R.string.mark_ok else R.string.mark_warn, getString(labelRes))
        view.setTextColor(ContextCompat.getColor(this, if (done) R.color.ok else R.color.warn))
    }

    private fun intervalFor(checkedId: Int): Int = when (checkedId) {
        R.id.interval1 -> 60
        R.id.interval3 -> 180
        else -> Store.DEFAULT_INTERVAL_MINUTES
    }

    private fun renderInterval() {
        val want = when (store.intervalMinutes) {
            60 -> R.id.interval1
            180 -> R.id.interval3
            else -> R.id.interval2
        }
        if (intervalGroup.checkedRadioButtonId != want) intervalGroup.check(want)
    }

    private fun renderTiming() {
        val clock = SimpleDateFormat("dd.MM HH:mm", Locale.US)
        lastFixText.text = if (store.lastFixAt > 0) {
            getString(
                R.string.info_last_fix,
                clock.format(Date(store.lastFixAt)),
                String.format(Locale.US, "%.4f, %.4f", store.lastFixLat, store.lastFixLon),
            )
        } else {
            getString(R.string.info_last_fix_none)
        }

        val next = store.nextTickAt
        nextTickText.text = if (next > System.currentTimeMillis()) {
            getString(R.string.info_next, SimpleDateFormat("HH:mm", Locale.US).format(Date(next)))
        } else {
            getString(R.string.info_next_now)
        }

        val queued = runCatching { store.pendingCount() }.getOrDefault(0)
        queueText.visibility = if (queued > 0) View.VISIBLE else View.GONE
        queueText.text = getString(R.string.info_queue, queued)

        errorText.visibility = if (store.lastError.isEmpty()) View.GONE else View.VISIBLE
        errorText.text = getString(R.string.info_error, store.lastError)
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}
