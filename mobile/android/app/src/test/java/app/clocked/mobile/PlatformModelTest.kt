package app.clocked.mobile

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** A platform-owned event clock. It never calls the collector to decide whether history shifts. */
class PlatformModelTest {
    private val min = 60_000L
    private val hour = 3_600_000L
    private val base = 1_800_000_000_000L
    private class History(var events: List<UsageEvent>) {
        private var pending = 0L
        fun correction(delta: Long, aosp: Boolean) {
            pending += delta
            if (aosp && kotlin.math.abs(pending) > 2000) { events = events.map { it.copy(at = it.at + pending) }; pending = 0 }
        }
        val source = EventSource { start, end -> events.filter { it.at >= start && it.at < end }.sortedBy { it.at } }
    }
    private fun snapshot(seconds: Long, elapsedSeconds: Long = seconds, boot: Int = 1, secure: Boolean = true) =
        PlatformSnapshot(base + seconds * 1000, elapsedSeconds * 1000, boot, true, true, true, true, secure, "UTC")
    private fun data() = DeviceData(token = "clk_test_credential", selected = setOf("work"), state = TrackingState(base, interactive = true, unlocked = true),
        zone = "UTC", permission = true, boot = 1, wall = base, elapsed = 0)
    private fun ev(seconds: Long, kind: Kind, pkg: String = "work") = UsageEvent(base + seconds * 1000, kind, pkg, "Main")
    private fun intervals(d: DeviceData) = Timeline.union(d.sessions.map { it.interval }).map { Interval((it.start - base) / 1000, (it.end - base) / 1000) }

    @Test fun censusTimestampOwners() {
        val d = data()
        val h = History(listOf(ev(3600, Kind.RESUME), ev(7000, Kind.SCREEN_ON)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        d.selections.add(SelectionChange(base + 7170_000, setOf("work")))
        d.zones.add(ZoneChange(base + 7170_000, "UTC"))
        val completed = Session("android-immutable-census", Interval(base + 1000, base + 2000), "UTC")
        d.sessions.add(completed)
        val oldCursor = d.state.cursor; val oldOpen = d.state.open!!
        h.correction(-90_000, aosp = true)
        CollectionPolicy.collect(d, snapshot(14400, elapsedSeconds = 14490), h.source)
        val file = File("build/reports/platform-model-census.tsv")
        requireNotNull(file.parentFile).mkdirs()
        file.writeText("owner\told_ms\texpected_delta_ms\tactual_ms\n" +
            "OS_RESUME\t${base + hour}\t-90000\t${h.events.first().at}\n" +
            "unemitted_cursor\t$oldCursor\t-90000_before_collect\t${d.state.cursor}\n" +
            "unemitted_open\t$oldOpen\t-90000\t${d.state.open}\n" +
            "selection\t${base + 7170_000}\t-90000\t${d.selections.last().at}\n" +
            "zone\t${base + 7170_000}\t-90000\t${d.zones.last().at}\n" +
            "completed_payload\t${completed.interval.start}\t0\t${d.sessions.first { it.id == completed.id }.interval.start}\n")
        assertEquals(completed, d.sessions.first { it.id == completed.id })
        assertEquals(base + 3510_000, d.state.open)
        assertEquals(base + 7080_000, d.selections.last().at)
        assertEquals(base + 7080_000, d.zones.last().at)
    }

    @Test fun appendixT1SecureGatesPrecedeStartup() {
        val d = data()
        val h = History(listOf(ev(3600, Kind.RESUME), ev(7200, Kind.SHUTDOWN), ev(7260, Kind.SCREEN_ON),
            ev(7320, Kind.UNLOCK), UsageEvent(base + 7320_200, Kind.STARTUP), ev(7380, Kind.RESUME), ev(10980, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(18000, 10800, boot = 2), h.source)
        assertEquals(listOf(Interval(3600, 7200), Interval(7380, 10980)), intervals(d))
    }

    @Test fun appendixT1bSwipeUnlockFollowsStartup() {
        val d = data()
        val h = History(listOf(ev(3600, Kind.RESUME), ev(7200, Kind.SHUTDOWN), ev(7260, Kind.SCREEN_ON),
            UsageEvent(base + 7260_500, Kind.STARTUP), ev(7320, Kind.UNLOCK), ev(7380, Kind.RESUME), ev(10980, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(18000, 10800, boot = 2, secure = false), h.source)
        assertEquals(listOf(Interval(3600, 7200), Interval(7380, 10980)), intervals(d))
    }

    @Test fun appendixT2UnshiftedJumpPreservesProvenPrefix() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        CollectionPolicy.collect(d, snapshot(9600, 9000), h.source)
        assertEquals(listOf(Interval(3600, 7140)), intervals(d))
    }

    @Test fun appendixT3ShiftedHistoryPreservesGapAndBothVisits() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7170, Kind.PAUSE), ev(7800, Kind.RESUME), ev(8400, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.correction(10 * min, aosp = true)
        CollectionPolicy.collect(d, snapshot(9600, 9000), h.source)
        assertEquals(listOf(Interval(4200, 7770), Interval(8400, 9000)), intervals(d))
        assertEquals(4170L, intervals(d).sumOf { it.end - it.start })
    }

    @Test fun appendixT4NegativeNinetySecondsNeverBillsPersonalHour() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7170, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.correction(-90_000, aosp = true)
        h.events += listOf(ev(7200, Kind.RESUME, "personal"), ev(10800, Kind.SCREEN_OFF))
        CollectionPolicy.collect(d, snapshot(14400, 14490), h.source)
        assertEquals(listOf(Interval(3510, 7080)), intervals(d))
        assertEquals(3570L, intervals(d).sumOf { it.end - it.start })
    }

    @Test fun appendixT6RetainedClosingEvidenceAfterNinetySixHours() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.events += ev(10800, Kind.SCREEN_OFF)
        CollectionPolicy.collect(d, snapshot(367200), h.source)
        assertEquals(listOf(Interval(3600, 10800)), intervals(d))
    }

    @Test fun appendixT7SynthesizedShutdownBeforeCheckpointKeepsProvenWork() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.events += listOf(ev(5400, Kind.SHUTDOWN), ev(9000, Kind.STARTUP))
        CollectionPolicy.collect(d, snapshot(10800, 1200, boot = 2), h.source)
        assertEquals(listOf(Interval(3600, 7140)), intervals(d))
    }

    @Test fun literalCorrectionMatrixBothSignsAtTwoAndOneHundredTwentySeconds() {
        // delta, AOSP shifted start, AOSP shifted end. Values are literal platform-model goldens.
        val cases = listOf(
            listOf(-1999L, 3600000L, 7170000L), listOf(1999L, 3600000L, 7170000L),
            listOf(-2000L, 3600000L, 7170000L), listOf(2000L, 3600000L, 7170000L),
            listOf(-2001L, 3597999L, 7167999L), listOf(2001L, 3602001L, 7172001L),
            listOf(-119999L, 3480001L, 7050001L), listOf(119999L, 3719999L, 7289999L),
            listOf(-120000L, 3480000L, 7050000L), listOf(120000L, 3720000L, 7290000L),
            listOf(-120001L, 3479999L, 7049999L), listOf(120001L, 3720001L, 7290001L))
        for (aosp in listOf(true, false)) for ((delta, start, end) in cases) {
            val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7170, Kind.PAUSE)))
            CollectionPolicy.collect(d, snapshot(7200), h.source)
            h.correction(delta, aosp)
            h.events += listOf(ev(7200, Kind.RESUME, "personal"), ev(10800, Kind.SCREEN_OFF))
            CollectionPolicy.collect(d, snapshot(14400).copy(now = base + 14400_000 + delta), h.source)
            val expected = if (aosp) Interval(base + start, base + end) else Interval(base + 3600000, base + 7170000)
            assertEquals("delta=$delta aosp=$aosp", listOf(expected), Timeline.union(d.sessions.map { it.interval }))
            assertEquals(3570000L, Timeline.union(d.sessions.map { it.interval }).sumOf { it.end - it.start })
        }
    }

    @Test fun accumulatedSubThresholdCorrectionsUseObservedFrameNotLastSampleDelta() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7170, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.correction(1500, aosp = true)
        CollectionPolicy.collect(d, snapshot(7200).copy(now = base + 7201_500), h.source)
        h.correction(1500, aosp = true)
        CollectionPolicy.collect(d, snapshot(14400).copy(now = base + 14403_000), h.source)
        assertEquals(listOf(Interval(base + 3603_000, base + 7173_000)), d.sessions.map { it.interval })
    }

    @Test fun pendingAndSyncedPayloadsRemainByteForByteImmutableWhenHistoryMoves() {
        for (synced in listOf(false, true)) {
            val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(4200, Kind.PAUSE), ev(6000, Kind.RESUME), ev(7170, Kind.PAUSE)))
            CollectionPolicy.collect(d, snapshot(7200), h.source)
            val completed = d.sessions.single().copy(synced = synced)
            d.sessions[0] = completed
            val payload = completed.json().toString()
            h.correction(-90000, aosp = true)
            CollectionPolicy.collect(d, snapshot(14400, 14490), h.source)
            assertEquals(completed, d.sessions.first { it.id == completed.id })
            assertEquals(payload, d.sessions.first { it.id == completed.id }.json().toString())
            assertEquals(listOf(Interval(3600, 4200), Interval(5910, 7080)), intervals(d))
        }
    }

    @Test fun selectionAndZoneBoundariesMoveWithProvenUnemittedHistory() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7000, Kind.SCREEN_ON)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        d.zones.add(ZoneChange(base + 7180_000, "Europe/Berlin")); d.zone = "Europe/Berlin"
        CollectionPolicy.changeSelection(d, base + 7190_000, emptySet())
        h.correction(600000, aosp = true)
        CollectionPolicy.collect(d, snapshot(9600, 9000).copy(zone = "Europe/Berlin"), h.source)
        assertEquals(listOf(Interval(4200, 7790)), intervals(d))
        assertEquals(listOf(Interval(base + 4200_000, base + 7780_000), Interval(base + 7780_000, base + 7790_000)), d.sessions.map { it.interval })
        assertEquals(listOf("UTC", "Europe/Berlin"), d.sessions.map { it.timezone })
    }

    @Test fun missingFingerprintProofSealsOnlyProvenWorkNeverPersonalTime() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.events = listOf(ev(7200, Kind.RESUME, "personal"), ev(10800, Kind.SCREEN_OFF))
        CollectionPolicy.collect(d, snapshot(14400, 14490), h.source)
        assertEquals(listOf(Interval(3600, 7140)), intervals(d))
        assertNull(d.state.open)
        assertTrue(d.boundaryNotice.contains("uncertain"))
    }

    @Test fun conflictingFingerprintOffsetsAreNotGuessed() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7000, Kind.SCREEN_ON)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.events += h.events.map { it.copy(at = it.at - 90000) }
        h.events += listOf(ev(7200, Kind.RESUME, "personal"), ev(10800, Kind.SCREEN_OFF))
        CollectionPolicy.collect(d, snapshot(14400, 14490), h.source)
        assertEquals(listOf(Interval(3600, 7140)), intervals(d))
        assertTrue(d.boundaryNotice.contains("could not be uniformly proved"))
    }

    @Test fun resumeBeforeStartupAndUnlockOrdersPreserveNewBootGates() {
        val cases = listOf(
            // secure, unlock-before-startup, resume-start and expected-count-start
            listOf(1L, 7320L, 7322L, 7321L, 7321L),
            listOf(1L, 7322L, 7320L, 7321L, 7322L),
            listOf(0L, 7320L, 7322L, 7321L, 7321L),
            listOf(0L, 7322L, 7320L, 7321L, 7321L))
        for ((secure, unlockAt, startupAt, resumeAt, expectedAt) in cases) {
            val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7200, Kind.SHUTDOWN),
                ev(7260, Kind.SCREEN_ON), ev(unlockAt, Kind.UNLOCK), ev(startupAt, Kind.STARTUP), ev(resumeAt, Kind.RESUME), ev(10980, Kind.PAUSE)))
            CollectionPolicy.collect(d, snapshot(18000, 10800, boot = 2, secure = secure == 1L), h.source)
            assertEquals(listOf(Interval(3600, 7200), Interval(expectedAt, 10980)), intervals(d))
        }
    }

    @Test fun twoRebootsInOneGapDoNotEraseEitherBootsFirstVisit() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7200, Kind.SHUTDOWN),
            ev(7260, Kind.SCREEN_ON), ev(7320, Kind.UNLOCK), ev(7321, Kind.STARTUP), ev(7380, Kind.RESUME), ev(10980, Kind.PAUSE),
            ev(14400, Kind.SHUTDOWN), ev(14460, Kind.SCREEN_ON), ev(14520, Kind.UNLOCK), ev(14521, Kind.STARTUP),
            ev(14580, Kind.RESUME), ev(18180, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(21600, 7200, boot = 3), h.source)
        assertEquals(listOf(Interval(3600, 7200), Interval(7380, 10980), Interval(14580, 18180)), intervals(d))
    }

    @Test fun uncleanShutdownBeforeCursorStillAllowsFirstNewBootVisit() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.events += listOf(ev(5400, Kind.SHUTDOWN), ev(7800, Kind.SCREEN_ON), ev(7860, Kind.UNLOCK),
            ev(7861, Kind.RESUME), ev(7862, Kind.STARTUP), ev(11461, Kind.PAUSE))
        CollectionPolicy.collect(d, snapshot(14400, 6600, boot = 2), h.source)
        assertEquals(listOf(Interval(3600, 7140), Interval(7861, 11461)), intervals(d))
    }

    @Test fun loneRepeatedResumeCannotProveAHistoryShift() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.correction(-90000, aosp = true)
        h.events += ev(7080, Kind.PAUSE)
        CollectionPolicy.collect(d, snapshot(14400, 14490), h.source)
        assertEquals(listOf(Interval(3600, 7140)), intervals(d))
        assertNull(d.state.open)
        assertTrue(d.boundaryNotice.contains("uncertain"))
    }

    @Test fun nonSecureSwipeLockIsNotErasedByStartup() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7200, Kind.SHUTDOWN), ev(7260, Kind.SCREEN_ON),
            ev(7261, Kind.LOCK), ev(7319, Kind.RESUME), ev(7320, Kind.STARTUP), ev(7322, Kind.UNLOCK), ev(10980, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(18000, 10800, boot = 2, secure = false), h.source)
        assertEquals(listOf(Interval(3600, 7200), Interval(7322, 10980)), intervals(d))
    }

    @Test fun startupPendingAndPreUnlockGatesSurviveSeparateCollections() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7200, Kind.SHUTDOWN), ev(7260, Kind.SCREEN_ON),
            ev(7320, Kind.UNLOCK), ev(7321, Kind.STARTUP), ev(7380, Kind.RESUME), ev(10980, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(7280, 80, boot = 2), h.source)
        assertTrue(d.state.startupPending)
        CollectionPolicy.collect(d, snapshot(7500, 300, boot = 2), h.source)
        assertFalse(d.state.startupPending)
        assertEquals(base + 7380_000, d.state.open)
        CollectionPolicy.collect(d, snapshot(18000, 10800, boot = 2), h.source)
        assertEquals(listOf(Interval(3600, 7200), Interval(7380, 10980)), intervals(d))
    }

    @Test fun selectionObservedAfterJumpBeforeNextProbeIsNotShiftedTwice() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7000, Kind.SCREEN_ON)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        h.correction(600000, aosp = true)
        CollectionPolicy.changeSelection(d, base + 7800_000, emptySet(), elapsed = 7200_000)
        CollectionPolicy.collect(d, snapshot(9600, 9000), h.source)
        assertEquals(listOf(Interval(4200, 7800)), intervals(d))
    }

    @Test fun rewriteTriggeredDuringQueryIsRetriedBeforeAdvancingCursor() {
        val d = data(); val h = History(listOf(ev(3600, Kind.RESUME), ev(7170, Kind.PAUSE)))
        CollectionPolicy.collect(d, snapshot(7200), h.source)
        val original = d.state
        val before = snapshot(14400)
        val after = snapshot(14400, 14490)
        val racing = EventSource { begin, end -> h.correction(-90000, aosp = true); h.source.query(begin, end) }
        val guarded = SampledEvents(before, racing) { after }
        CollectionPolicy.collect(d, before, guarded)
        assertTrue(guarded.changedDuringQuery)
        assertEquals(original, d.state)
        CollectionPolicy.collect(d, after, SampledEvents(after, h.source) { after })
        assertEquals(listOf(Interval(3510, 7080)), intervals(d))
    }
}
