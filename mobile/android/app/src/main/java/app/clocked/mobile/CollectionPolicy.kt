package app.clocked.mobile

import java.time.Instant
import java.time.ZoneId
import kotlin.math.abs

data class PlatformSnapshot(val now: Long, val elapsed: Long, val boot: Int, val allowed: Boolean,
    val userUnlocked: Boolean, val interactive: Boolean, val unlocked: Boolean, val deviceSecure: Boolean, val zone: String)
fun interface EventSource { fun query(begin: Long, end: Long): List<UsageEvent>? }

/** One transaction over the OS event frame. Completed session records never join frame migration. */
object CollectionPolicy {
    const val DAY = 86_400_000L
    const val RETENTION_LOOKBACK = 96 * 3_600_000L
    const val SAFETY_MARGIN = 60_000L

    private fun histories(data: DeviceData) {
        if (data.selections.isEmpty()) data.selections.add(SelectionChange(Long.MIN_VALUE, data.selected))
        if (data.zones.isEmpty()) data.zones.add(ZoneChange(Long.MIN_VALUE, data.zone))
    }

    fun changeSelection(data: DeviceData, now: Long, packages: Set<String>, elapsed: Long? = null) {
        histories(data)
        if (packages == data.selected) return
        // An action between a wall-clock change and the next OS query still belongs to the last
        // sampled event frame. Monotonic placement prevents applying the later shift twice.
        val eventAt = if (elapsed != null && elapsed >= data.elapsed) data.wall + data.eventOffset + elapsed - data.elapsed else now + data.eventOffset
        val at = maxOf(eventAt, data.state.cursor, data.selections.last().at)
        data.selections.add(SelectionChange(at, packages.toSet())); data.selected = packages.toSet()
        data.status = "Selection saved. Earlier events keep their original selection."
    }

    fun initialize(data: DeviceData, p: PlatformSnapshot, source: EventSource): Boolean {
        val begin = maxOf(0, p.now - RETENTION_LOOKBACK)
        val events = source.query(begin, p.now + 1) ?: return false
        val replay = Timeline.reconstruct(TrackingState(begin), p.now + 1, data.selected, events,
            startupUnlocked = !p.deviceSecure && p.unlocked).state
        val working = p.allowed && p.interactive && p.unlocked && replay.active.any { it.substringBefore('\u0000') in data.selected }
        data.state = replay.copy(cursor = p.now, interactive = p.interactive, unlocked = p.unlocked, running = true, open = if (working) p.now else null)
        data.permission = p.allowed; data.eventOffset = 0
        data.selections.clear(); data.selections.add(SelectionChange(Long.MIN_VALUE, data.selected))
        data.zones.clear(); data.zones.add(ZoneChange(Long.MIN_VALUE, p.zone)); data.zone = p.zone
        EventFrames.remember(data, events, p.now)
        samples(data, p)
        return true
    }

    fun permissionLost(data: DeviceData, now: Long) {
        data.state = TrackingState(now); data.permission = false; data.eventMarks.clear(); data.eventOffset = 0
        data.boundaryNotice = "Usage access was off at ${Instant.ofEpochMilli(now)}. That permission gap will not be backfilled."
        data.status = "Usage access is off. Collection paused."
    }

    fun collect(data: DeviceData, p: PlatformSnapshot, source: EventSource) {
        histories(data)
        if (data.token.isEmpty()) { data.status = "Connect your Clocked account to start."; return }
        if (!p.userUnlocked) { data.status = "Unlock the device after restart to collect usage."; return }
        if (!p.allowed) { permissionLost(data, p.now); return }
        if (!data.permission || data.state.cursor == 0L) {
            if (!initialize(data, p, source)) data.status = "Usage data unavailable. Collection will retry."
            else data.status = "Usage access enabled. Current activity restored; collection starts now."
            return
        }
        val sameBoot = p.boot == data.boot && p.elapsed >= data.elapsed
        val elapsedDelta = if (sameBoot) p.elapsed - data.elapsed else 0
        val drift = if (sameBoot) p.now - (data.wall + elapsedDelta) else 0
        val oldFrameNow = if (sameBoot) data.wall + elapsedDelta + data.eventOffset else data.wall + data.eventOffset
        val expectedShift = p.now - oldFrameNow
        val firstMark = data.eventMarks.minOfOrNull { it.at } ?: data.state.cursor
        val begin = maxOf(0, minOf(data.state.cursor, firstMark, firstMark + expectedShift,
            if (sameBoot) data.state.cursor else p.now - RETENTION_LOOKBACK))
        val queryEnd = maxOf(p.now, oldFrameNow, data.state.cursor, (data.eventMarks.maxOfOrNull { it.at } ?: 0) + expectedShift) + 2501
        // The probe includes known pre-change events and the delayed tail, before filtering by cursor.
        val events = source.query(begin, queryEnd)
        if (events == null) { data.status = "Usage data unavailable. Checkpoint retained for retry."; return }
        val proof = if (sameBoot) EventFrames.prove(data.eventMarks, events, expectedShift, drift) else FrameProof.Uniform(0)
        if (proof is FrameProof.Missing || (!sameBoot && p.now < data.state.cursor) ||
            (proof is FrameProof.Uniform && proof.shift == 0L && sameBoot && abs(expectedShift) > 2000)) {
            uncertainBoundary(data, p, events, maxOf(p.now, oldFrameNow, data.state.cursor))
            return
        }
        val shift = (proof as FrameProof.Uniform).shift
        if (shift != 0L) {
            EventFrames.shiftUnemitted(data, shift)
            data.boundaryNotice = "Retained history shifted by $shift ms, proved by local event fingerprints. Unemitted state and boundaries aligned; completed sessions unchanged."
        }
        data.eventOffset = if (sameBoot) data.eventOffset + shift - drift else 0
        // Sampling a new boot does not mean the delayed event window has reached it. Keep every
        // unconsumed boundary with its original proof checkpoint, including rapid repeated reboots.
        if (!sameBoot) data.state = data.state.copy(bootCuts = data.state.bootCuts + BootCut(p.boot, p.now - p.elapsed, data.state.cursor))
        val eventNow = p.now + data.eventOffset
        if (p.zone != data.zone) {
            data.zones.add(ZoneChange(maxOf(eventNow, data.state.cursor, data.zones.last().at), p.zone)); data.zone = p.zone
        }
        val end = eventNow - SAFETY_MARGIN
        if (end > data.state.cursor) {
            val firstAfterCursor = events.filter { it.at >= data.state.cursor && it.at < end }.minOfOrNull { it.at }
            // Evidence near the checkpoint can close a long-carried visit. Elapsed gap length alone
            // must not erase it. A genuinely absent prefix only seals the already-proven part.
            if (end - data.state.cursor > RETENTION_LOOKBACK && (firstAfterCursor ?: end) - data.state.cursor > RETENTION_LOOKBACK) {
                sealProven(data, data.state.cursor)
                data.state = TrackingState(data.state.cursor, bootCuts = data.state.bootCuts)
                data.boundaryNotice = "Retained history starts far beyond the checkpoint. Proven work was kept; the missing prefix is uncertain."
            }
            val result = Timeline.reconstruct(data.state, end, data.selected, events, data.selections,
                startupUnlocked = !p.deviceSecure && p.unlocked)
            result.intervals.forEach { enqueue(data, it) }; data.state = result.state
        }
        EventFrames.remember(data, events, eventNow)
        samples(data, p)
        data.sessions.removeAll { it.synced && it.interval.end < eventNow - 90 * DAY }
        prune(data)
        data.status = "Usage collected. Open sessions wait for a closing event."
    }

    private fun uncertainBoundary(data: DeviceData, p: PlatformSnapshot, events: List<UsageEvent>, upper: Long) {
        val checkpoint = data.state.cursor
        val oldNow = data.wall + data.eventOffset
        val marks = data.eventMarks.toSet()
        val confirmedTail = events.filter { it.at >= checkpoint && it.at <= oldNow && EventFrames.mark(it) in marks }
        if (oldNow >= checkpoint && confirmedTail.isNotEmpty()) {
            val tail = Timeline.reconstruct(data.state, oldNow + 1, data.selected, confirmedTail, data.selections)
            tail.intervals.forEach { enqueue(data, it) }; data.state = tail.state
        }
        sealProven(data, checkpoint)
        // Without a uniform frame, pre-change records may reappear in the future after a backward
        // correction. Do not reinterpret them as new resumes. Only events beyond both bounds qualify.
        data.state = TrackingState(upper + 2501)
        data.eventOffset = 0; data.eventMarks.clear()
        data.selections.clear(); data.selections.add(SelectionChange(Long.MIN_VALUE, data.selected))
        data.zones.clear(); data.zones.add(ZoneChange(Long.MIN_VALUE, p.zone)); data.zone = p.zone
        data.boundaryNotice = "Clock frame could not be uniformly proved or history was left unshifted. Proven work through ${Instant.ofEpochMilli(checkpoint)} retained, including previously observed closes. Time across the correction is uncertain; fresh gate/activity evidence beyond ${Instant.ofEpochMilli(data.state.cursor)} is required."
        data.status = "Clock uncertainty recorded. No work is inferred across the correction."
        samples(data, p)
    }

    private fun sealProven(data: DeviceData, checkpoint: Long) {
        val proven = minOf(checkpoint, data.state.bootCuts.minOfOrNull { it.checkpoint } ?: checkpoint)
        data.state.open?.takeIf { it < proven }?.let { enqueue(data, Interval(it, proven)) }
    }

    private fun samples(data: DeviceData, p: PlatformSnapshot) { data.wall = p.now; data.elapsed = p.elapsed; data.boot = p.boot }

    private fun prune(data: DeviceData) {
        val selectionBase = data.selections.lastOrNull { it.at <= data.state.cursor }
        data.selections.removeAll { it.at < data.state.cursor && it != selectionBase }
        val keepFrom = data.state.open ?: data.state.cursor
        val zoneBase = data.zones.lastOrNull { it.at <= keepFrom }
        data.zones.removeAll { it.at < keepFrom && it != zoneBase }
    }

    private fun enqueue(data: DeviceData, interval: Interval) {
        val cuts = (listOf(interval.start, interval.end) + data.zones.map { it.at }.filter { it > interval.start && it < interval.end }).distinct().sorted()
        cuts.zipWithNext().forEach { (start, end) ->
            val zone = data.zones.lastOrNull { it.at <= start }?.zone ?: data.zone
            Timeline.splitDays(Interval(start, end), ZoneId.of(zone)).forEach { part ->
                val id = Timeline.id(data.epoch, part)
                if (data.sessions.none { it.id == id }) data.sessions.add(Session(id, part, zone))
            }
        }
    }
}
