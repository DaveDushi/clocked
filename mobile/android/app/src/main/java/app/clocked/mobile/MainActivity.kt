package app.clocked.mobile

import android.content.Intent
import android.content.ActivityNotFoundException
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.lifecycleScope
import androidx.core.net.toUri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val Background = Color(0xff0a0b10)
private val Panel = Color(0xff151823)
private val Amber = Color(0xfff2a950)
data class WorkApp(val pkg: String, val label: String)
private enum class DestructiveAction { CONNECT, DISCONNECT }

class MainActivity : ComponentActivity() {
    private var revision by mutableIntStateOf(0)
    private var refreshing by mutableStateOf(false)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Amber, background = Background, surface = Panel,
                onBackground = Color(0xffe9eaf0), onSurface = Color(0xffe9eaf0), onSurfaceVariant = Color(0xff8b91a0), outline = Color(0xff242938))) {
                Clocked(revision)
            }
        }
    }
    override fun onResume() {
        super.onResume()
        refreshing = true
        lifecycleScope.launch(Dispatchers.IO) {
            try { Tracker(this@MainActivity).sync() } catch (_: Exception) { /* The screen reports unreadable storage without uploading. */ }
            finally { withContext(Dispatchers.Main) { revision++; refreshing = false } }
        }
    }

    @Composable
    private fun Clocked(revision: Int) {
        val tracker = remember { Tracker(this) }
        var data by remember { mutableStateOf<DeviceData?>(null) }
        var apps by remember { mutableStateOf(emptyList<WorkApp>()) }
        var error by remember { mutableStateOf("") }
        var server by remember { mutableStateOf("") }
        var token by remember { mutableStateOf("") }
        var search by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var permission by remember { mutableStateOf(false) }
        var confirmation by remember { mutableStateOf<DestructiveAction?>(null) }
        val scope = rememberCoroutineScope()
        fun action(onSuccess: () -> Unit = {}, block: () -> Unit) {
            busy = true; error = ""
            scope.launch {
                try {
                    withContext(Dispatchers.IO) { block() }
                    data = withContext(Dispatchers.IO) { tracker.read() }
                    permission = tracker.hasPermission()
                    onSuccess()
                } catch (e: Exception) {
                    error = e.message ?: "Device storage unavailable. Reopen the app or clear storage to reconnect."
                    try { data = withContext(Dispatchers.IO) { tracker.read() } } catch (_: Exception) { }
                }
                finally { busy = false }
            }
        }
        fun userSync() = action { SyncSchedule.now(this@MainActivity, userInitiated = true); tracker.sync() }
        fun connect(consent: DeletionConsent? = null) = action(onSuccess = { token = "" }) {
            tracker.configure(server, token, consent); SyncSchedule.now(this@MainActivity, userInitiated = true)
        }
        fun openIntent(primary: Intent, fallback: Intent? = null) {
            try { startActivity(primary) } catch (_: ActivityNotFoundException) {
                if (fallback == null) error = "No app is installed to open this link."
                else try { startActivity(fallback) }
                catch (_: ActivityNotFoundException) { error = "This device has no usage-access settings screen. Contact your device administrator." }
                catch (_: SecurityException) { error = "This device does not allow that settings screen." }
            } catch (_: SecurityException) { error = "This device does not allow that settings screen or link." }
        }
        confirmation?.let { operation ->
            val current = data
            if (current != null) {
                val pending = current.sessions.filter { !it.synced }
                val minutes = Timeline.union(pending.map { it.interval }).sumOf { it.end - it.start } / 60_000
                AlertDialog(onDismissRequest = { confirmation = null }, title = { Text("Delete this device's local history?") },
                    text = { Column {
                        Text("${pending.size} sessions (${minutes / 60}h ${minutes % 60}m) have not synced and will be deleted. Any open work session and local history will also be removed. Synced dashboard records stay in your account.")
                        Text("An upload already in flight can still finish for the previous account.")
                        if (pending.isNotEmpty()) TextButton(onClick = { confirmation = null; userSync() }) { Text("Sync with current connection first") }
                    } },
                    confirmButton = { TextButton(onClick = {
                        confirmation = null
                        val consent = DeletionConsent.from(current)
                        if (operation == DestructiveAction.CONNECT) connect(consent)
                        else action(onSuccess = { token = "" }) { tracker.disconnect(consent) }
                    }) { Text("Delete local history") } },
                    dismissButton = { TextButton(onClick = { confirmation = null }) { Text("Cancel") } })
            }
        }
        LaunchedEffect(revision) {
            try {
                data = withContext(Dispatchers.IO) { tracker.read() }
                permission = tracker.hasPermission()
                if (server.isEmpty()) server = data?.origin?.ifEmpty { "https://clocked.daviddusi.com" } ?: "https://clocked.daviddusi.com"
                apps = withContext(Dispatchers.IO) {
                    packageManager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                        .map { WorkApp(it.activityInfo.packageName, it.loadLabel(packageManager).toString()) }
                        .filter { it.pkg != packageName }.distinctBy { it.pkg }.sortedBy { it.label.lowercase() }
                }
            } catch (_: Exception) { error = "Cannot read encrypted device storage. Clear app storage to reconnect. No data was uploaded." }
        }
        LazyColumn(Modifier.fillMaxSize().background(Background).statusBarsPadding().navigationBarsPadding().imePadding().padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 24.dp)) {
            item {
                Text("CLOCKED", color = Amber, style = MaterialTheme.typography.labelLarge)
                Text("Your work, counted.", style = MaterialTheme.typography.headlineLarge)
                Text("Aggregate work time", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val zone = ZoneId.systemDefault()
                        val start = LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli()
                        val end = LocalDate.now(zone).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
                        val total = Timeline.union(data?.sessions.orEmpty().map { Interval(maxOf(start, it.interval.start), minOf(end, it.interval.end)) }).sumOf { it.end - it.start } / 60_000
                        Text("TODAY ON THIS DEVICE", style = MaterialTheme.typography.labelMedium)
                        Text("${total / 60}h ${total % 60}m", color = Amber, style = MaterialTheme.typography.displaySmall)
                        Text(data?.status ?: "Loading encrypted device storage…")
                        if (refreshing) Text("Background sync running…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (!data?.boundaryNotice.isNullOrEmpty()) Text(data!!.boundaryNotice, color = Amber)
                        Text("${data?.sessions?.count { !it.synced } ?: 0} sessions waiting to sync", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Button(enabled = !busy && data != null, onClick = { userSync() }) { Text(if (busy) "Working…" else "Sync now") }
                        if (!data?.origin.isNullOrEmpty()) TextButton(onClick = {
                            openIntent(Intent(Intent.ACTION_VIEW, data!!.origin.toUri()))
                        }) { Text("Open full dashboard") }
                    }
                }
            }
            item {
                Text("Usage access", style = MaterialTheme.typography.titleLarge)
                Text(if (permission) "Allowed. Selected resumed apps count while the screen is on and unlocked." else "Allow usage access to track selected work apps. Revoking access pauses collection.")
                OutlinedButton(onClick = { openIntent(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, "package:$packageName".toUri()), Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }) { Text("Manage usage access") }
            }
            item {
                Text("Connection", style = MaterialTheme.typography.titleLarge)
                Text("Create a device token in dashboard Settings. Changing the server or token clears this device's local history and pending uploads to protect account boundaries.")
                OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), label = { Text("HTTPS server origin") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !busy)
                OutlinedTextField(token, { token = it }, Modifier.fillMaxWidth(), label = { Text("Device token") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), enabled = !busy)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !busy && token.isNotEmpty(), onClick = {
                        try {
                            Protocol.origin(server)
                            if (!data?.token.isNullOrEmpty() && (data!!.origin != server.trimEnd('/') || data!!.token != token)) confirmation = DestructiveAction.CONNECT
                            else connect()
                        } catch (_: Exception) { error = "Enter an HTTPS server origin without a path, query, or login." }
                    }) { Text("Save connection") }
                    TextButton(enabled = !busy && data != null, onClick = { confirmation = DestructiveAction.DISCONNECT }) { Text("Disconnect") }
                }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                if (data == null && error.isNotEmpty()) TextButton(onClick = {
                    openIntent(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
                }) { Text("Open app storage settings") }
            }
            item {
                Text("Work apps", style = MaterialTheme.typography.titleLarge)
                Text("${data?.selected?.size ?: 0} selected. Changes take effect now. Earlier usage keeps its original selection.")
                Text("App identities stay on this device. Only the combined work-time intervals sync; app names, package IDs, and per-app breakdowns are never uploaded.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Only this Android profile is tracked. Work-profile apps require Clocked installed and authorized inside that profile.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(search, { search = it }, Modifier.fillMaxWidth(), label = { Text("Find an app") }, singleLine = true)
            }
            items(apps.filter { it.label.contains(search, true) || it.pkg.contains(search, true) }, key = { it.pkg }) { app ->
                val checked = app.pkg in data?.selected.orEmpty()
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).toggleable(value = checked, enabled = !busy && data != null, role = Role.Checkbox,
                    onValueChange = { value -> val next = data!!.selected.toMutableSet().apply { if (value) add(app.pkg) else remove(app.pkg) }; action { tracker.select(next) } }), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Checkbox(checked = checked, enabled = !busy && data != null, onCheckedChange = null)
                    Column(Modifier.padding(top = 6.dp)) {
                        Text(app.label); Text(app.pkg, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item {
                Text("Recent completed sessions", style = MaterialTheme.typography.titleLarge)
                Text("Open sessions appear after a closing event. The dashboard unions these intervals with desktop time.")
            }
            items(data?.sessions.orEmpty().sortedByDescending { it.interval.start }.take(10), key = { it.id }) { session ->
                val formatter = DateTimeFormatter.ofPattern("MMM d, HH:mm").withZone(ZoneId.of(session.timezone))
                Text("${formatter.format(Instant.ofEpochMilli(session.interval.start))} · ${(session.interval.end - session.interval.start) / 60_000} min · ${if (session.synced) "Synced" else "Pending"}")
            }
            item { Text("Android can delay collection for more than a day. Clocked queries retained events since its checkpoint; Android guarantees no exact retention period. Missing closing events can overcount until a screen, lock, or shutdown gate. Multiwindow counts resumed work, not eye attention. Unproved clock frames and missing history can undercount; the boundary notice identifies uncertainty.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
