package app.clocked.mobile

import java.security.MessageDigest
import kotlin.math.abs

data class EventMark(val at: Long, val signature: String)
sealed interface FrameProof {
    data class Uniform(val shift: Long) : FrameProof
    data object Missing : FrameProof
}

object EventFrames {
    fun mark(event: UsageEvent) = EventMark(event.at, MessageDigest.getInstance("SHA-256")
        .digest("${event.kind}\u0000${event.pkg}\u0000${event.activity}".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) })

    fun prove(known: List<EventMark>, events: List<UsageEvent>, expectedShift: Long, drift: Long): FrameProof {
        val observed = events.map(::mark).distinct()
        val offsets = mutableMapOf<Long, MutableSet<EventMark>>()
        known.forEach { prior -> observed.filter { it.signature == prior.signature }.forEach { event ->
            val shift = event.at - prior.at
            if (shift == 0L || abs(shift - expectedShift) <= 2500) offsets.getOrPut(shift) { mutableSetOf() }.add(prior)
        } }
        // One repeated RESUME is not an event identity. Require an agreeing pattern, and reject
        // conflicting patterns instead of choosing the offset with the most matches.
        val candidates = offsets.filterValues { it.size >= 2 }.keys
        if (candidates.size == 1) return FrameProof.Uniform(candidates.single())
        if (candidates.any { it != 0L } || abs(drift) > 2000) return FrameProof.Missing
        // No detected correction and no contradicting retained evidence. Missing history is handled
        // separately; its absence is not evidence that the clock moved.
        return FrameProof.Uniform(0)
    }

    fun remember(data: DeviceData, events: List<UsageEvent>, observedThrough: Long) {
        data.eventMarks.clear()
        data.eventMarks.addAll(events.filter { it.at <= observedThrough }.distinct().sortedBy { it.at }.takeLast(32).map(::mark))
    }

    fun shiftUnemitted(data: DeviceData, shift: Long) {
        if (shift == 0L) return
        data.state = data.state.copy(cursor = Math.addExact(data.state.cursor, shift), open = data.state.open?.let { Math.addExact(it, shift) })
        for (i in data.selections.indices) {
            val change = data.selections[i]
            if (change.at != Long.MIN_VALUE) data.selections[i] = change.copy(at = Math.addExact(change.at, shift))
        }
        for (i in data.zones.indices) {
            val change = data.zones[i]
            if (change.at != Long.MIN_VALUE) data.zones[i] = change.copy(at = Math.addExact(change.at, shift))
        }
        // Session IDs, payloads and acknowledgment flags are intentionally outside this operation.
    }
}
