package app.clocked.mobile

import org.junit.Assert.*
import org.junit.Test
import android.app.AppOpsManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SyncEngineTest {
    private val row = Session("android-old", Interval(10, 20), "UTC")
    private class Store(var data: DeviceData) : DeviceStore {
        override fun read() = data
        override fun write(data: DeviceData) { this.data = data }
    }
    private fun old() = DeviceData(origin = "https://a.example", token = "clk_account_old", epoch = "old", sessions = mutableListOf(row))

    @Test fun networkWaitReleasesLockAndOldResponseCannotAcknowledgeNewAccount() {
        val lock = Any()
        val store = Store(old())
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        val transport = UploadTransport { snapshot ->
            assertEquals("clk_account_old", snapshot.token)
            PendingUpload {
                assertFalse(Thread.holdsLock(lock))
                started.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS))
                UploadResult.Response(200, """{"accepted":["android-old"]}""")
            }
        }
        val newAccount = DeviceData(origin = "https://b.example", token = "clk_account_new", epoch = "new",
            sessions = mutableListOf(Session("android-new", Interval(30, 40), "UTC")), status = "new account untouched")
        try {
            val job = executor.submit<Boolean> { SyncEngine(store, lock, transport, mutableSetOf()).sync() }
            assertTrue(started.await(2, TimeUnit.SECONDS))
            synchronized(lock) { store.write(newAccount) }
            release.countDown()
            assertTrue(job.get(2, TimeUnit.SECONDS))
            assertEquals("new account untouched", store.data.status)
            assertEquals(listOf(Session("android-new", Interval(30, 40), "UTC")), store.data.sessions)
        } finally { release.countDown(); executor.shutdownNow() }
    }

    @Test fun boundaryBetweenCaptureAndInitiationPreventsOldRequestStart() {
        var reads = 0
        var starts = 0
        var current = old()
        val store = object : DeviceStore {
            override fun read(): DeviceData {
                reads++
                if (reads == 2) current = current.withConnection("https://new.example", "clk_new_token")
                return current
            }
            override fun write(data: DeviceData) { current = data }
        }
        val transport = UploadTransport { starts++; PendingUpload { UploadResult.Unavailable } }
        assertTrue(SyncEngine(store, Any(), transport, mutableSetOf()).sync())
        assertEquals(0, starts)
    }

    @Test fun partialAndFailedRetriesPreserveIdsAndRotateRejectedRows() {
        val second = Session("android-second", Interval(30, 40), "UTC")
        val store = Store(old().apply { sessions.add(second) })
        val transport = UploadTransport { PendingUpload { UploadResult.Response(200, """{"accepted":["android-second","foreign"]}""") } }
        assertFalse(SyncEngine(store, Any(), transport, mutableSetOf()).sync())
        assertEquals(listOf(second.copy(synced = true), row), store.data.sessions)
        val retry = UploadTransport { captured ->
            assertEquals(listOf(row), captured.batch)
            PendingUpload { UploadResult.Unavailable }
        }
        assertFalse(SyncEngine(store, Any(), retry, mutableSetOf()).sync())
        assertEquals(row, store.data.sessions.last())
    }

    @Test fun destructiveConsentRejectsNewlyCollectedPendingWork() {
        val data = old()
        val consent = DeletionConsent.from(data)
        data.sessions.add(Session("android-newly-collected", Interval(30, 40), "UTC"))
        try { consent.check(data); fail("New pending work silently deleted") } catch (_: IllegalArgumentException) { }
    }

    @Test fun permissionDefaultUsesManifestGrantAndOtherDenialsStayDenied() {
        assertTrue(permissionGranted(AppOpsManager.MODE_DEFAULT, true))
        assertFalse(permissionGranted(AppOpsManager.MODE_DEFAULT, false))
        assertTrue(permissionGranted(AppOpsManager.MODE_ALLOWED, false))
        assertFalse(permissionGranted(AppOpsManager.MODE_IGNORED, true))
    }
}
