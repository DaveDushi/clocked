package app.clocked.mobile

import android.Manifest
import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.os.UserManager
import android.provider.Settings
import java.time.ZoneId

class Tracker(private val context: Context) {
    companion object {
        val lock = Any()
        private val activeEpochs = mutableSetOf<String>()
        private val upload = HttpUpload()
    }
    private val vault = Vault(context)
    fun hasPermission(): Boolean {
        val mode = context.getSystemService(AppOpsManager::class.java)
            .unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        return permissionGranted(mode, context.checkSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED)
    }

    private fun platform(): PlatformSnapshot {
        val elapsed = SystemClock.elapsedRealtime()
        val now = System.currentTimeMillis()
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        return PlatformSnapshot(now, elapsed, Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1),
            hasPermission(), context.getSystemService(UserManager::class.java).isUserUnlocked,
            context.getSystemService(PowerManager::class.java).isInteractive, !keyguard.isKeyguardLocked,
            keyguard.isDeviceSecure, ZoneId.systemDefault().id)
    }

    private val source = EventSource { begin, end ->
        val usage = context.getSystemService(UsageStatsManager::class.java).queryEvents(begin, end)
        if (usage == null) null else {
            val events = mutableListOf<UsageEvent>()
            val event = UsageEvents.Event()
            while (usage.hasNextEvent()) {
                usage.getNextEvent(event)
                val kind = when (event.eventType) {
                    UsageEvents.Event.ACTIVITY_RESUMED -> Kind.RESUME
                    UsageEvents.Event.ACTIVITY_PAUSED -> Kind.PAUSE
                    UsageEvents.Event.ACTIVITY_STOPPED -> Kind.STOP
                    UsageEvents.Event.SCREEN_INTERACTIVE -> Kind.SCREEN_ON
                    UsageEvents.Event.SCREEN_NON_INTERACTIVE -> Kind.SCREEN_OFF
                    UsageEvents.Event.KEYGUARD_HIDDEN -> Kind.UNLOCK
                    UsageEvents.Event.KEYGUARD_SHOWN -> Kind.LOCK
                    UsageEvents.Event.DEVICE_SHUTDOWN -> Kind.SHUTDOWN
                    UsageEvents.Event.DEVICE_STARTUP -> Kind.STARTUP
                    else -> null
                }
                if (kind != null) events.add(UsageEvent(event.timeStamp, kind, event.packageName.orEmpty(), event.className.orEmpty()))
            }
            if (!hasPermission()) throw SecurityException("Usage access revoked")
            events
        }
    }

    fun read(): DeviceData = synchronized(lock) { vault.read() }

    fun configure(origin: String, token: String, confirmation: DeletionConsent? = null) = synchronized(lock) {
        val server = Protocol.origin(origin)
        require(token.startsWith("clk_") && token.length >= 12 && token.none { it.isWhitespace() || it.code < 32 }) { "Paste a Clocked device token from dashboard Settings." }
        val previous = vault.read()
        val data = previous.withConnection(server, token)
        if (data !== previous) {
            confirmation?.check(previous) ?: require(previous.token.isEmpty() && previous.sessions.isEmpty()) { "Confirm deletion of local history before changing this connection." }
            val p = platform()
            data.zone = p.zone
            if (p.allowed && p.userUnlocked) CollectionPolicy.initialize(data, p, SampledEvents(p, source, ::platform))
            data.status = "Connected locally. Sync will verify this device token."
            vault.write(data)
        }
    }

    fun select(packages: Set<String>) = synchronized(lock) {
        val data = vault.read()
        collect(data)
        CollectionPolicy.changeSelection(data, System.currentTimeMillis(), packages, SystemClock.elapsedRealtime())
        vault.write(data)
    }

    private fun collect(data: DeviceData) {
        try {
            repeat(2) {
                val p = platform()
                val sampled = SampledEvents(p, source, ::platform)
                CollectionPolicy.collect(data, p, sampled)
                if (!sampled.changedDuringQuery) return
            }
        }
        catch (_: SecurityException) { CollectionPolicy.permissionLost(data, System.currentTimeMillis()) }
    }

    /** Broadcasts only collect and persist. They never wait for network I/O. */
    fun collectOnly() = synchronized(lock) {
        val data = vault.read(); collect(data); vault.write(data)
    }

    fun permissionChanged(allowed: Boolean, at: Long) = synchronized(lock) {
        val data = vault.read()
        if (!allowed) CollectionPolicy.permissionLost(data, at) else collect(data)
        vault.write(data)
    }

    fun sync(): Boolean {
        collectOnly()
        return SyncEngine(vault, lock, upload, activeEpochs).sync()
    }

    fun disconnect(confirmation: DeletionConsent) = synchronized(lock) {
        confirmation.check(vault.read()); vault.write(DeviceData())
    }
}

fun permissionGranted(mode: Int, manifestGranted: Boolean) = mode == AppOpsManager.MODE_ALLOWED ||
    (mode == AppOpsManager.MODE_DEFAULT && manifestGranted)

data class DeletionConsent(val epoch: String, val pendingIds: Set<String>) {
    fun check(data: DeviceData) {
        require(epoch == data.epoch && data.sessions.none { !it.synced && it.id !in pendingIds }) {
            "Local pending work changed. Review the deletion confirmation again."
        }
    }
    companion object { fun from(data: DeviceData) = DeletionConsent(data.epoch, data.sessions.filter { !it.synced }.map { it.id }.toSet()) }
}
