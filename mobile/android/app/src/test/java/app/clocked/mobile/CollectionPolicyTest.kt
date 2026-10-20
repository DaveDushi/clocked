package app.clocked.mobile

import org.junit.Assert.*
import org.junit.Test

class CollectionPolicyTest {
    private val hour = 3_600_000L
    private val base = 1_800_000_000_000L
    private fun snapshot(now: Long, elapsed: Long = now - base, boot: Int = 1, zone: String = "UTC",
        secure: Boolean = true, allowed: Boolean = true) = PlatformSnapshot(now, elapsed, boot, allowed, true, true, true, secure, zone)
    private fun data() = DeviceData(token = "clk_test_credential", selected = setOf("work"), state = TrackingState(base, interactive = true, unlocked = true),
        zone = "UTC", permission = true, boot = 1, wall = base, elapsed = 0)
    private fun event(offset: Long, kind: Kind, pkg: String = "work") = UsageEvent(base + offset, kind, pkg, "Main")
    private fun source(vararg events: UsageEvent) = EventSource { start, end -> events.filter { it.at >= start && it.at < end } }

    @Test fun thirtyHourStandbyGapRecoversClosedWork() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 30 * hour), source(event(hour, Kind.RESUME), event(3 * hour, Kind.PAUSE)))
        assertEquals(listOf(Interval(base + hour, base + 3 * hour)), d.sessions.map { it.interval })
    }

    @Test fun olderRetainedEventsAreQueriedEvenBeyondWarmReplayWindow() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 120 * hour), source(event(0, Kind.SCREEN_ON), event(1, Kind.UNLOCK),
            event(hour, Kind.RESUME), event(3 * hour, Kind.PAUSE)))
        assertEquals(listOf(Interval(base + hour, base + 3 * hour)), d.sessions.map { it.interval })
        assertEquals("", d.boundaryNotice)
    }

    @Test fun rebootReadsShutdownBeforeStartupAndRequiresSecureUnlock() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 6 * hour, elapsed = 4 * hour, boot = 2), source(
            event(hour, Kind.RESUME), event(2 * hour, Kind.SHUTDOWN), event(3 * hour + 4, Kind.STARTUP),
            event(3 * hour + 1, Kind.SCREEN_ON), event(3 * hour + 2, Kind.RESUME), event(3 * hour + 3, Kind.PAUSE),
            event(4 * hour, Kind.UNLOCK), event(4 * hour + 1, Kind.RESUME), event(5 * hour, Kind.PAUSE)))
        assertEquals(listOf(Interval(base + hour, base + 2 * hour), Interval(base + 4 * hour + 1, base + 5 * hour)),
            Timeline.union(d.sessions.map { it.interval }))
        assertEquals(2, d.boot)
    }

    @Test fun rebootWithoutKeyguardHiddenEventStillCountsNonSecureDevice() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 6 * hour, elapsed = 4 * hour, boot = 2, secure = false), source(
            event(hour, Kind.RESUME), event(2 * hour, Kind.SHUTDOWN), event(3 * hour, Kind.STARTUP),
            event(3 * hour - 1, Kind.SCREEN_ON), event(4 * hour, Kind.RESUME), event(5 * hour, Kind.PAUSE)))
        assertEquals(listOf(Interval(base + hour, base + 2 * hour), Interval(base + 4 * hour, base + 5 * hour)),
            Timeline.union(d.sessions.map { it.interval }))
    }

    @Test fun timezoneChangePreservesUtcTimeAcrossOpenVisit() {
        val d = data()
        val events = source(event(hour, Kind.RESUME), event(2 * hour, Kind.PAUSE), event(3 * hour, Kind.RESUME), event(5 * hour, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 4 * hour, zone = "Europe/Berlin"), events)
        CollectionPolicy.collect(d, snapshot(base + 6 * hour, zone = "Europe/Berlin"), events)
        assertEquals(listOf(Interval(base + hour, base + 2 * hour), Interval(base + 3 * hour, base + 5 * hour)), Timeline.union(d.sessions.map { it.interval }))
        assertEquals("UTC", d.sessions.first { it.interval.start == base + 3 * hour }.timezone)
        assertEquals("Europe/Berlin", d.sessions.first { it.interval.start == base + 4 * hour }.timezone)
    }

    @Test fun selectionImmediatelyAfterPauseInSafetyMarginDoesNotLoseTwoHourVisit() {
        val d = data()
        val events = source(event(1000, Kind.RESUME), event(2 * hour, Kind.PAUSE),
            event(2 * hour + 40_000, Kind.RESUME), event(3 * hour, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 2 * hour + 30_000), events)
        assertEquals(base + 1000, d.state.open)
        CollectionPolicy.changeSelection(d, base + 2 * hour + 30_000, emptySet())
        CollectionPolicy.collect(d, snapshot(base + 4 * hour), events)
        assertEquals(listOf(Interval(base + 1000, base + 2 * hour)), d.sessions.map { it.interval })
    }

    @Test fun selectingAlreadyResumedAppCountsFromChangeWithoutWaitingForNewResume() {
        val d = data().apply { selected = emptySet() }
        val events = source(event(hour, Kind.RESUME), event(3 * hour, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), events)
        CollectionPolicy.changeSelection(d, base + 2 * hour, setOf("work"))
        CollectionPolicy.collect(d, snapshot(base + 4 * hour), events)
        assertEquals(listOf(Interval(base + 2 * hour, base + 3 * hour)), d.sessions.map { it.interval })
    }

    @Test fun permissionReturnRestoresResumedActivityButNeverBackfillsOptOut() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + hour, allowed = false), source())
        CollectionPolicy.collect(d, snapshot(base + 2 * hour), source(event(0, Kind.RESUME)))
        assertEquals(base + 2 * hour, d.state.open)
        CollectionPolicy.collect(d, snapshot(base + 4 * hour), source(event(3 * hour, Kind.PAUSE)))
        assertEquals(listOf(Interval(base + 2 * hour, base + 3 * hour)), d.sessions.map { it.interval })
        assertTrue(d.boundaryNotice.contains("permission gap"))
    }

    @Test fun unavailableQueryDoesNotAdvanceCheckpointEvenAfterLongGap() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 120 * hour), EventSource { _, _ -> null })
        assertEquals(base, d.state.cursor)
        assertTrue(d.sessions.isEmpty())
    }

    @Test fun multiwindowAndSelectionChangesStillUploadOnlyOneUnion() {
        val d = data()
        CollectionPolicy.changeSelection(d, base, setOf("work", "editor"))
        CollectionPolicy.collect(d, snapshot(base + 4 * hour), source(event(hour, Kind.RESUME), event(2 * hour, Kind.RESUME, "editor"),
            event(2 * hour + 1000, Kind.PAUSE), event(3 * hour, Kind.PAUSE, "editor")))
        assertEquals(listOf(Interval(base + hour, base + 3 * hour)), d.sessions.map { it.interval })
        val body = Protocol.payload(d.sessions)
        assertFalse(body.contains("editor")); assertFalse(body.contains("Main")); assertFalse(body.contains("work"))
    }

    @Test fun unrelatedResumeDoesNotInventTaskOwnershipAndEvictValidSplitScreenWork() {
        val d = data()
        CollectionPolicy.collect(d, snapshot(base + 4 * hour), source(event(hour, Kind.RESUME),
            event(2 * hour, Kind.RESUME, "personal"), event(3 * hour, Kind.SCREEN_OFF)))
        assertEquals(listOf(Interval(base + hour, base + 3 * hour)), d.sessions.map { it.interval })
    }
}
