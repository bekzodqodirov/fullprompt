package uz.gsr.driver

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
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
 * which is why the permission prompts are chained here instead of being left
 * to the driver.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var store: Store
    private val io = Executors.newSingleThreadExecutor()

    private lateinit var pairPanel: View
    private lateinit var statusPanel: View
    private lateinit var serverInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var pairButton: Button
    private lateinit var tripText: TextView
    private lateinit var statusText: TextView
    private lateinit var permissionButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = Store(this)

        pairPanel = findViewById(R.id.pairPanel)
        statusPanel = findViewById(R.id.statusPanel)
        serverInput = findViewById(R.id.serverInput)
        codeInput = findViewById(R.id.codeInput)
        pairButton = findViewById(R.id.pairButton)
        tripText = findViewById(R.id.tripText)
        statusText = findViewById(R.id.statusText)
        permissionButton = findViewById(R.id.permissionButton)

        serverInput.setText(store.server)
        pairButton.setOnClickListener { pair() }
        permissionButton.setOnClickListener { requestPermissions() }
        findViewById<Button>(R.id.batteryButton).setOnClickListener { openBatterySettings() }
        findViewById<Button>(R.id.stopButton).setOnClickListener { stopTrip() }

        render()
    }

    override fun onResume() {
        super.onResume()
        render()
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
                    requestPermissions()
                    render()
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

    // --- Permissions -------------------------------------------------------

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

    /**
     * Android insists the background grant is asked for SEPARATELY, after the
     * foreground one is already given — so this walks one step at a time and
     * is re-invoked from onResume until everything is in place.
     */
    private fun requestPermissions() {
        if (!hasForegroundLocation()) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
                1,
            )
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotifications()) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                2,
            )
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasBackgroundLocation()) {
            toast(getString(R.string.background_hint))
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
                3,
            )
            return
        }
        if (store.isPaired) TrackingService.start(this)
        render()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        requestPermissions()
    }

    /**
     * Chinese OEM skins kill background services unless the app is excluded
     * from battery optimisation — the single most common reason tracking goes
     * silent, so it gets its own button.
     */
    private fun openBatterySettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:$packageName"))
        runCatching { startActivity(intent) }
            .onFailure { toast(getString(R.string.error_settings)) }
    }

    // --- Rendering ---------------------------------------------------------

    private fun render() {
        val paired = store.isPaired
        pairPanel.visibility = if (paired) View.GONE else View.VISIBLE
        statusPanel.visibility = if (paired) View.VISIBLE else View.GONE
        if (!paired) return

        tripText.text = store.tripLabel.ifEmpty { getString(R.string.trip_active) }

        val lines = ArrayList<String>()
        lines.add(
            when {
                !hasForegroundLocation() -> getString(R.string.status_no_permission)
                !hasBackgroundLocation() -> getString(R.string.status_background_missing)
                else -> getString(R.string.status_ok)
            }
        )
        val queued = store.pendingCount()
        if (queued > 0) lines.add(getString(R.string.status_queued, queued))
        if (store.lastSentAt > 0) {
            val time = SimpleDateFormat("dd.MM HH:mm", Locale.US).format(Date(store.lastSentAt))
            lines.add(getString(R.string.status_last_sent, time))
        }
        if (store.lastError.isNotEmpty()) {
            lines.add(getString(R.string.status_last_error, store.lastError))
        }
        statusText.text = lines.joinToString("\n")

        permissionButton.visibility =
            if (hasForegroundLocation() && hasBackgroundLocation() && hasNotifications()) {
                View.GONE
            } else {
                View.VISIBLE
            }

        if (hasForegroundLocation()) TrackingService.start(this)
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}
