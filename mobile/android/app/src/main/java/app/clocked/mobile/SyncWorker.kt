package app.clocked.mobile

import android.app.Application
import android.app.AppOpsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try { if (Tracker(applicationContext).sync()) Result.success() else Result.retry() }
        catch (_: Exception) { Result.retry() }
    }
}

object SyncSchedule {
    fun start(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("clocked-periodic", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }
    fun now(context: Context, userInitiated: Boolean = false) {
        WorkManager.getInstance(context).enqueueUniqueWork("clocked-now", if (userInitiated) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<SyncWorker>().setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
    }
}

class ClockedApplication : Application() {
    private val events = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val usageListener = AppOpsManager.OnOpChangedListener { _, pkg ->
        if (pkg == packageName) {
            val allowed = Tracker(this).hasPermission()
            val at = System.currentTimeMillis()
            events.execute {
                try { Tracker(this).permissionChanged(allowed, at); SyncSchedule.now(this) } catch (_: Exception) { }
            }
        }
    }
    override fun onCreate() {
        super.onCreate()
        getSystemService(AppOpsManager::class.java).startWatchingMode(AppOpsManager.OPSTR_GET_USAGE_STATS, packageName, usageListener)
        SyncSchedule.start(this)
    }
}

class ClockReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
            else -> return
        }
        val pending = goAsync()
        Thread {
            try {
                Tracker(context).collectOnly()
                SyncSchedule.start(context); SyncSchedule.now(context)
            } catch (_: Exception) {
                // A later worker retries; never replace an unreadable vault with an empty one.
            } finally { pending.finish() }
        }.start()
    }
}
