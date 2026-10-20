package app.clocked.mobile

import okhttp3.OkHttpClient
import okhttp3.Dns
import org.junit.Assert.*
import org.junit.Test
import java.net.UnknownHostException
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class HttpUploadTest {
    @Test fun blockedResolverCannotKeepCallerWaitingPastFiniteDeadline() {
        val resolving = CountDownLatch(1)
        val release = CountDownLatch(1)
        val client = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                resolving.countDown()
                release.await(5, TimeUnit.SECONDS)
                throw UnknownHostException("test resolver released")
            }
        }).build()
        try {
            val pending = HttpUpload(client, waitMillis = 100).start(UploadSnapshot("epoch", "https://clocked.invalid", "clk_local_test_only",
                listOf(Session("android-test", Interval(10, 20), "UTC"))))
            assertTrue(resolving.await(2, TimeUnit.SECONDS))
            val begin = System.nanoTime()
            assertEquals(UploadResult.Unavailable, pending.await())
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begin) < 1500)
        } finally { release.countDown(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
    }
}
