package app.clocked.mobile

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class TimelineTest {
    private val ready = TrackingState(0, interactive = true, unlocked = true)
    private fun e(at: Long, kind: Kind, pkg: String = "work", activity: String = "Main") = UsageEvent(at, kind, pkg, activity)

    @Test fun splitScreenAndMultipleActivitiesCountOnce() {
        val events = listOf(e(10, Kind.RESUME), e(20, Kind.RESUME, activity = "Editor"),
            e(30, Kind.RESUME, "other"), e(40, Kind.PAUSE), e(50, Kind.PAUSE, activity = "Editor"), e(70, Kind.STOP, "other"))
        assertEquals(listOf(Interval(10, 70)), Timeline.reconstruct(ready, 100, setOf("work", "other"), events).intervals)
    }
    @Test fun unselectedAppsNeverStartTime() {
        assertEquals(emptyList<Interval>(), Timeline.reconstruct(ready, 100, setOf("editor"), listOf(e(10, Kind.RESUME), e(50, Kind.PAUSE))).intervals)
    }
    @Test fun duplicatesAndOutOfOrderEventsDoNotCountTwice() {
        val events = listOf(e(50, Kind.PAUSE), e(10, Kind.RESUME), e(10, Kind.RESUME), e(50, Kind.PAUSE))
        assertEquals(listOf(Interval(10, 50)), Timeline.reconstruct(ready, 100, setOf("work"), events).intervals)
    }
    @Test fun queryEndIsExclusiveAndOpenSessionWaitsForEvidence() {
        val first = Timeline.reconstruct(ready, 50, setOf("work"), listOf(e(10, Kind.RESUME), e(50, Kind.PAUSE)))
        assertEquals(emptyList<Interval>(), first.intervals)
        assertEquals(10L, first.state.open)
        assertEquals(50L, first.state.cursor)
        val second = Timeline.reconstruct(first.state, 100, setOf("work"), listOf(e(49, Kind.PAUSE), e(50, Kind.PAUSE)))
        assertEquals(listOf(Interval(10, 50)), second.intervals)
    }
    @Test fun screenOffAndKeyguardCloseTimeWithoutWaitingForPause() {
        val events = listOf(e(10, Kind.RESUME), e(30, Kind.SCREEN_OFF), e(40, Kind.SCREEN_ON), e(45, Kind.UNLOCK),
            e(50, Kind.RESUME), e(80, Kind.LOCK), e(90, Kind.RESUME))
        assertEquals(listOf(Interval(10, 30), Interval(50, 80)), Timeline.reconstruct(ready, 100, setOf("work"), events).intervals)
    }
    @Test fun unknownInitialGatesDoNotInventUnlockedTime() {
        assertEquals(emptyList<Interval>(), Timeline.reconstruct(TrackingState(0), 100, setOf("work"), listOf(e(10, Kind.RESUME), e(50, Kind.PAUSE))).intervals)
    }
    @Test fun shutdownClosesAtLastPersistedTimestampAndIgnoresLaterOpens() {
        val events = listOf(e(10, Kind.RESUME), e(30, Kind.SHUTDOWN), e(40, Kind.RESUME), e(80, Kind.STARTUP))
        val result = Timeline.reconstruct(ready, 100, setOf("work"), events)
        assertEquals(listOf(Interval(10, 30)), result.intervals)
        assertNull(result.state.open)
    }
    @Test fun unexpectedStartupDropsUnclosedTime() {
        val result = Timeline.reconstruct(ready, 100, setOf("work"), listOf(e(10, Kind.RESUME), e(80, Kind.STARTUP)))
        assertEquals(emptyList<Interval>(), result.intervals)
        assertNull(result.state.open)
    }
    @Test fun simultaneousActivityHandoffHasNoGap() {
        assertEquals(listOf(Interval(10, 80)), Timeline.reconstruct(ready, 100, setOf("work"), listOf(
            e(10, Kind.RESUME), e(50, Kind.PAUSE), e(50, Kind.RESUME, activity = "Editor"), e(80, Kind.PAUSE, activity = "Editor"))).intervals)
    }
    @Test fun unionClipsOverlapsAndAdjacentIntervals() {
        assertEquals(listOf(Interval(10, 50), Interval(80, 90)), Timeline.union(listOf(
            Interval(30, 50), Interval(10, 40), Interval(40, 45), Interval(80, 90), Interval(90, 90))))
    }
    @Test fun dstDaysUseCalendarMidnights() {
        val zone = ZoneId.of("Europe/Berlin")
        val spring = Timeline.splitDays(Interval(ms("2026-03-28T23:00:00Z"), ms("2026-03-30T22:00:00Z")), zone)
        assertEquals(listOf(Interval(ms("2026-03-28T23:00:00Z"), ms("2026-03-29T22:00:00Z")), Interval(ms("2026-03-29T22:00:00Z"), ms("2026-03-30T22:00:00Z"))), spring)
        val autumn = Timeline.splitDays(Interval(ms("2026-10-24T22:00:00Z"), ms("2026-10-26T23:00:00Z")), zone)
        assertEquals(25 * 3_600_000L, autumn.first().end - autumn.first().start)
        assertEquals(2, autumn.size)
    }
    @Test fun idsSurviveRetryAndChangeAcrossAccountEpochs() {
        val interval = Interval(10, 20)
        assertEquals("android-776c785c8c39bae2adac466c9b569795a8ead426439ffa5350fa3483fb4dd3fd", Timeline.id("account-a", interval))
        assertEquals(Timeline.id("account-a", interval), Timeline.id("account-a", Interval(10, 20)))
        assertNotEquals(Timeline.id("account-a", interval), Timeline.id("account-b", interval))
        assertNotEquals(Timeline.id("account-a", interval), Timeline.id("account-a", Interval(10, 21)))
        assertTrue(Timeline.id("a", interval).matches(Regex("android-[a-f0-9]{64}")))
    }
    private fun ms(value: String) = Instant.parse(value).toEpochMilli()
}
