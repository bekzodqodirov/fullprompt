package uz.gsr.calls

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Two screens in one: pairing (the staff member's own phone, their own code
 * from /profile) and sync status.
 *
 * The checklist mirrors the driver app's: the two runtime permissions, the
 * battery allowlist, the vendor auto-start list — plus the one step no app
 * can do or check: the PHONE's own call recorder has to be switched on,
 * because Android hands no third-party app the call audio and the design is
 * to pick up the files the built-in recorder writes.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val STEP_CALLS = 1
        const val STEP_AUDIO = 2
        const val STEP_BATTERY = 3
        const val STEP_AUTOSTART = 4
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
    private lateinit var setupCard: View
    private lateinit var textCalls: TextView
    private lateinit var textAudio: TextView
    private lateinit var textBattery: TextView
    private lateinit var textAutostart: TextView
    private lateinit var textRecorder: TextView
    private lateinit var btnAutostartDone: Button
    private lateinit var btnRecorderDone: Button
    private lateinit var lastSyncText: TextView
    private lateinit var sentText: TextView
    private lateinit var queueText: TextView
    private lateinit var errorText: TextView
    private lateinit var syncNowButton: Button

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
        setupCard = findViewById(R.id.setupCard)
        textCalls = findViewById(R.id.textCalls)
        textAudio = findViewById(R.id.textAudio)
        textBattery = findViewById(R.id.textBattery)
        textAutostart = findViewById(R.id.textAutostart)
        textRecorder = findViewById(R.id.textRecorder)
        btnAutostartDone = findViewById(R.id.btnAutostartDone)
        btnRecorderDone = findViewById(R.id.btnRecorderDone)
        lastSyncText = findViewById(R.id.lastSyncText)
        sentText = findViewById(R.id.sentText)
        queueText = findViewById(R.id.queueText)
        errorText = findViewById(R.id.errorText)
        syncNowButton = findViewById(R.id.syncNowButton)

        serverInput.setText(store.server)
        findViewById<TextView>(R.id.versionText).text = getString(
            R.string.app_version,
            getString(R.string.app_tagline),
            BuildConfig.VERSION_NAME,
            BuildConfig.BUILD_ID,
        )
        pairButton.setOnClickListener { pair() }

        for (id in intArrayOf(R.id.btnCalls, R.id.btnAudio, R.id.btnBattery)) {
            findViewById<Button>(id).setOnClickListener { runChain() }
        }
        findViewById<Button>(R.id.btnAutostart).setOnClickListener { openAutostart() }
        btnAutostartDone.setOnClickListener {
            store.autostartConfirmed = true
            render()
        }
        btnRecorderDone.setOnClickListener {
            store.recorderConfirmed = true
            render()
        }
        syncNowButton.setOnClickListener { syncNow() }
        findViewById<Button>(R.id.unpairButton).setOnClickListener { unpair() }

        render()
    }

    override fun onResume() {
        super.onResume()
        if (chainActive) step() else render()
        if (store.isPaired) Schedule.ensure(this, store)
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
                val token = Api.pair(server, code)
                store.server = server
                store.token = token
                // The owner's answer: recording starts the day the app is
                // installed — nothing older is ever read from the register.
                val floor = startOfToday()
                store.lastLogAt = floor
                store.installFloor = floor
                Schedule.ensure(this, store)
                Schedule.soon(this, 5_000L)
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

    private fun startOfToday(): Long {
        val cal = Calendar.getInstance()
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    private fun unpair() {
        Schedule.cancelAll(this)
        store.clearAll()
        render()
    }

    private fun syncNow() {
        syncNowButton.isEnabled = false
        syncNowButton.text = getString(R.string.syncing)
        io.execute {
            runCatching { Sync.cycle(this, store) }
            runOnUiThread {
                syncNowButton.isEnabled = true
                syncNowButton.text = getString(R.string.sync_now)
                render()
            }
        }
    }

    // --- Setup chain -------------------------------------------------------

    private fun hasCallLog(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) ==
            PackageManager.PERMISSION_GRANTED

    /** The media grant differs by version; ask for the one THIS phone uses. */
    private fun audioPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_AUDIO
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }

    private fun hasAudio(): Boolean =
        ContextCompat.checkSelfPermission(this, audioPermission()) == PackageManager.PERMISSION_GRANTED

    private fun nextMissingStep(): Int? = when {
        !hasCallLog() -> STEP_CALLS
        !hasAudio() -> STEP_AUDIO
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
     * One step at a time, stopping when a step it already offered is still
     * not satisfied — otherwise a refusal would loop forever (the driver
     * app's chain).
     */
    private fun step() {
        if (!chainActive) return
        val next = nextMissingStep()
        if (next == null) {
            chainActive = false
            asked.clear()
            render()
            return
        }
        if (!asked.add(next)) {
            chainActive = false
            render()
            return
        }
        when (next) {
            STEP_CALLS -> ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.READ_CALL_LOG),
                STEP_CALLS,
            )

            STEP_AUDIO -> ActivityCompat.requestPermissions(this, arrayOf(audioPermission()), STEP_AUDIO)

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

    // --- Rendering ---------------------------------------------------------

    private fun render() {
        val paired = store.isPaired
        pairPanel.visibility = if (paired) View.GONE else View.VISIBLE
        statusPanel.visibility = if (paired) View.VISIBLE else View.GONE
        if (!paired) {
            // The one goodbye worth words: /profile pressed «Uzish» and the
            // 410 landed here — say so instead of silently asking for a code.
            if (store.lastError == "revoked") toast(getString(R.string.state_revoked))
            return
        }

        val calls = hasCallLog()
        val audio = hasAudio()
        val battery = Setup.batteryUnrestricted(this)
        val autostart = store.autostartConfirmed
        val recorder = store.recorderConfirmed

        mark(textCalls, R.string.check_calls, calls)
        mark(textAudio, R.string.check_audio, audio)
        mark(textBattery, R.string.check_battery, battery)
        mark(textAutostart, R.string.check_autostart, autostart)
        mark(textRecorder, R.string.check_recorder, recorder)
        btnAutostartDone.visibility = if (autostart) View.GONE else View.VISIBLE
        btnRecorderDone.visibility = if (recorder) View.GONE else View.VISIBLE

        val ready = calls && audio && battery && autostart && recorder
        setupCard.visibility = if (ready) View.GONE else View.VISIBLE
        stateText.text = getString(if (ready) R.string.state_ok else R.string.state_setup)
        stateText.setTextColor(
            ContextCompat.getColor(this, if (ready) R.color.ok else R.color.warn),
        )
        stateHint.text = getString(if (ready) R.string.state_hint_ok else R.string.state_hint_setup)

        val clock = SimpleDateFormat("dd.MM HH:mm", Locale.US)
        lastSyncText.text = if (store.lastSyncAt > 0) {
            getString(R.string.info_last_sync, clock.format(Date(store.lastSyncAt)))
        } else {
            getString(R.string.info_last_sync_none)
        }
        sentText.text = getString(R.string.info_sent, store.sentCalls, store.sentAudio)

        // Always on screen (v1.1): a silent audio pass cost a day of guessing
        // — the queue plus the last pass's counters answer «why no player».
        val queued = runCatching { store.pendingAudioCount() }.getOrDefault(0)
        queueText.visibility = View.VISIBLE
        queueText.text = buildString {
            append(getString(R.string.info_queue, queued))
            if (store.audioStatus.isNotEmpty()) {
                append('\n')
                append(getString(R.string.info_audio_pass, store.audioStatus))
            }
        }

        errorText.visibility = if (store.lastError.isEmpty()) View.GONE else View.VISIBLE
        errorText.text = getString(R.string.info_error, store.lastError)
    }

    private fun mark(view: TextView, labelRes: Int, done: Boolean) {
        view.text = getString(if (done) R.string.mark_ok else R.string.mark_warn, getString(labelRes))
        view.setTextColor(ContextCompat.getColor(this, if (done) R.color.ok else R.color.warn))
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}
