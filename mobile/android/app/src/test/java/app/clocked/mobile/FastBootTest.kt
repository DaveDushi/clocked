package app.clocked.mobile

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import javax.crypto.KeyGenerator

class FastBootTest {
    private val base = 1_800_000_000_000L
    private fun snapshot(s: Long, el: Long, boot: Int) = PlatformSnapshot(base + s * 1000, el * 1000, boot, true, true, true, true, true, "UTC")
    private fun data() = DeviceData(token = "clk_test_credential", selected = setOf("work"), state = TrackingState(base, interactive = true, unlocked = true),
        zone = "UTC", permission = true, boot = 1, wall = base, elapsed = 0)
    private fun ev(s: Long, kind: Kind) = UsageEvent(base + s * 1000, kind, "work", "Main")
    private val pre = listOf(ev(3600, Kind.RESUME))
    private val fresh = listOf(ev(9620, Kind.SCREEN_ON), ev(9640, Kind.UNLOCK), UsageEvent(base + 9640_200, Kind.STARTUP), ev(9700, Kind.RESUME), ev(10000, Kind.PAUSE))
    private fun source(events: List<UsageEvent>) = EventSource { a, b -> events.filter { it.at >= a && it.at < b }.sortedBy { it.at } }
    private fun intervals(d: DeviceData) = d.sessions.map { Interval((it.interval.start - base) / 1000, (it.interval.end - base) / 1000) }
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private fun restart(d: DeviceData): DeviceData {
        val path = Files.createTempFile("clocked-fast-boot-", ".enc")
        try {
            Files.write(path, VaultFormat.encode(d, key))
            val restored = VaultFormat.decode(Files.readAllBytes(path), key)
            assertNotSame(d, restored)
            assertEquals(d.state, restored.state)
            assertEquals(d.sessions, restored.sessions)
            assertEquals(d.epoch, restored.epoch)
            assertEquals(d.boot, restored.boot)
            return restored
        } finally { Files.delete(path) }
    }

    private fun appendix(firstElapsed: Long) {
        var d = data()
        CollectionPolicy.collect(d, snapshot(7200, 7200, 1), source(pre))
        val events = pre + ev(5400, Kind.SHUTDOWN) + fresh
        CollectionPolicy.collect(d, snapshot(9600 + firstElapsed, firstElapsed, 2), source(events))
        d = restart(d)
        CollectionPolicy.collect(d, snapshot(12000, 2400, 2), source(events))
        assertEquals(listOf(Interval(3600, 7140), Interval(9700, 10000)), intervals(d))
    }
    @Test fun appendixFast45Seconds() = appendix(45)
    @Test fun appendixSlow120Seconds() = appendix(120)

    @Test fun encryptedRestartMatrixRetainsOriginalCheckpointAndConsumesCutOnce() {
        // Literal expected output, with no union that could conceal duplicate persisted rows.
        for (elapsed in listOf(0L, 30L, 45L, 59L, 60L, 120L)) {
            for (shutdown in listOf<Long?>(null, 5400, 7140, 9000)) {
                var d = data()
                CollectionPolicy.collect(d, snapshot(7200, 7200, 1), source(pre))
                val events = pre + (shutdown?.let { listOf(ev(it, Kind.SHUTDOWN)) } ?: emptyList()) + fresh
                CollectionPolicy.collect(d, snapshot(9600 + elapsed, elapsed, 2), source(events))
                d = restart(d)
                if (elapsed <= 60) assertEquals(listOf(BootCut(2, base + 9600_000, base + 7140_000)), d.state.bootCuts)
                else assertTrue(d.state.bootCuts.isEmpty())
                CollectionPolicy.collect(d, snapshot(12000, 2400, 2), source(events))
                val expected = listOf(Interval(3600, if (shutdown == 9000L) 9000 else 7140), Interval(9700, 10000))
                assertEquals("elapsed=$elapsed shutdown=$shutdown", expected, intervals(d))
                assertTrue(d.state.bootCuts.isEmpty())
                val rows = d.sessions.toList()
                d = restart(d)
                CollectionPolicy.collect(d, snapshot(12100, 2500, 2), source(events))
                assertEquals(rows, d.sessions)
                assertFalse(d.state.startupPending)
            }
        }
    }

    @Test fun severalEarlyCollectionsCannotAdvanceSavedProof() {
        var d = data()
        CollectionPolicy.collect(d, snapshot(7200, 7200, 1), source(pre))
        for (elapsed in listOf(0L, 30L, 45L, 59L, 60L)) {
            CollectionPolicy.collect(d, snapshot(9600 + elapsed, elapsed, 2), source(pre + fresh))
            d = restart(d)
            assertEquals(listOf(BootCut(2, base + 9600_000, base + 7140_000)), d.state.bootCuts)
        }
        CollectionPolicy.collect(d, snapshot(12000, 2400, 2), source(pre + fresh))
        assertEquals(listOf(Interval(3600, 7140), Interval(9700, 10000)), intervals(d))
    }

    @Test fun rapidSecondRebootCannotOverwriteUnconsumedFirstCut() {
        var d = data()
        CollectionPolicy.collect(d, snapshot(7200, 7200, 1), source(pre))
        CollectionPolicy.collect(d, snapshot(9600, 0, 2), source(pre))
        d = restart(d)
        CollectionPolicy.collect(d, snapshot(9630, 0, 3), source(pre))
        d = restart(d)
        assertEquals(listOf(BootCut(2, base + 9600_000, base + 7140_000), BootCut(3, base + 9630_000, base + 9540_000)), d.state.bootCuts)
        val events = pre + listOf(ev(9650, Kind.SCREEN_ON), ev(9660, Kind.UNLOCK), ev(9661, Kind.STARTUP), ev(9700, Kind.RESUME), ev(10000, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(12000, 2370, 3), source(events))
        assertEquals(listOf(Interval(3600, 7140), Interval(9700, 10000)), intervals(d))
        assertTrue(d.state.bootCuts.isEmpty())
        val rows = d.sessions.toList()
        d = restart(d)
        CollectionPolicy.collect(d, snapshot(12100, 2470, 3), source(events))
        assertEquals(rows, d.sessions)
    }

    @Test fun failedQueryDoesNotConsumeOrDuplicateBootBoundary() {
        var d = data()
        CollectionPolicy.collect(d, snapshot(7200, 7200, 1), source(pre))
        CollectionPolicy.collect(d, snapshot(9645, 45, 2), EventSource { _, _ -> null })
        assertEquals(1, d.boot)
        d = restart(d)
        CollectionPolicy.collect(d, snapshot(9659, 59, 2), source(pre + fresh))
        d = restart(d)
        CollectionPolicy.collect(d, snapshot(12000, 2400, 2), source(pre + fresh))
        assertEquals(listOf(Interval(3600, 7140), Interval(9700, 10000)), intervals(d))
    }

    @Test fun pendingCutAndProofFollowProvenEventFrameWithoutRetimingCompletedRows() {
        for (shiftSeconds in listOf(-90L, 90L)) {
            var d = data()
            val history = pre + ev(7000, Kind.SCREEN_ON)
            CollectionPolicy.collect(d, snapshot(7200, 7200, 1), source(history))
            CollectionPolicy.collect(d, snapshot(9645, 45, 2), source(history + fresh))
            val completed = Session("immutable-retry", Interval(base + 1000, base + 2000), "UTC")
            d.sessions.add(completed)
            d = restart(d)
            val shifted = (history + fresh).map { it.copy(at = it.at + shiftSeconds * 1000) }
            CollectionPolicy.collect(d, snapshot(12000 + shiftSeconds, 2400, 2), source(shifted))
            assertEquals(completed, d.sessions.first())
            assertEquals(listOf(Interval(3600 + shiftSeconds, 7140 + shiftSeconds), Interval(9700 + shiftSeconds, 10000 + shiftSeconds)), intervals(d).drop(1))
            assertTrue(d.state.bootCuts.isEmpty())
        }
    }
}
