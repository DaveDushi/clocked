package app.clocked.mobile

import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId

enum class Kind { RESUME, PAUSE, STOP, SCREEN_ON, SCREEN_OFF, UNLOCK, LOCK, SHUTDOWN, STARTUP }
data class UsageEvent(val at: Long, val kind: Kind, val pkg: String = "", val activity: String = "")
data class Interval(val start: Long, val end: Long)
data class BootCut(val boot: Int, val at: Long, val checkpoint: Long)
data class TrackingState(
    val cursor: Long,
    val active: Set<String> = emptySet(),
    val interactive: Boolean = false,
    val unlocked: Boolean = false,
    val running: Boolean = true,
    val open: Long? = null,
    val startupPending: Boolean = false,
    val bootCuts: List<BootCut> = emptyList(),
)
data class Reconstruction(val state: TrackingState, val intervals: List<Interval>)
data class SelectionChange(val at: Long, val packages: Set<String>)
data class ZoneChange(val at: Long, val zone: String)

object Timeline {
    // The query is [cursor, end). No inferred end at query time: open spans wait for closing evidence.
    fun reconstruct(initial: TrackingState, end: Long, selected: Set<String>, events: List<UsageEvent>,
        selections: List<SelectionChange> = emptyList(), startupUnlocked: Boolean = false): Reconstruction {
        require(end >= initial.cursor)
        var active = initial.active.toMutableSet()
        var interactive = initial.interactive
        var unlocked = initial.unlocked
        var running = initial.running
        var open = initial.open
        var startupPending = initial.startupPending
        var selection = selections.lastOrNull { it.at <= initial.cursor }?.packages ?: selected
        val result = mutableListOf<Interval>()
        val groups = events.filter { it.at >= initial.cursor && it.at < end }.distinct().sortedBy { it.at }.groupBy { it.at }
        val changes = selections.filter { it.at >= initial.cursor && it.at < end }.groupBy { it.at }
        val reachedCuts = initial.bootCuts.filter { it.at < end }.groupBy { maxOf(initial.cursor, it.at) }
        (groups.keys + changes.keys + reachedCuts.keys).sorted().forEach { at ->
                val group = groups[at].orEmpty()
                changes[at]?.lastOrNull()?.let { selection = it.packages }
                // A boot-start estimate only delimits uncertainty. It never emits work to that estimate.
                if (at in reachedCuts && group.none { it.kind == Kind.SHUTDOWN }) {
                    val checkpoint = reachedCuts.getValue(at).minOf { it.checkpoint }
                    if (open != null && checkpoint > open!!) result.add(Interval(open!!, checkpoint))
                    open = null; active.clear(); interactive = false; unlocked = startupUnlocked
                    startupPending = true; running = true
                }
                if (!running && group.none { it.kind == Kind.SHUTDOWN }) running = true
                group.forEach { e ->
                    val key = "${e.pkg}\u0000${e.activity}"
                    when (e.kind) {
                        Kind.RESUME -> if (running) active.add(key)
                        Kind.PAUSE, Kind.STOP -> active.remove(key)
                        Kind.SCREEN_ON -> interactive = true
                        Kind.UNLOCK -> unlocked = true
                        Kind.SCREEN_OFF -> { interactive = false; active.clear() }
                        Kind.LOCK -> { unlocked = false; active.clear() }
                        Kind.SHUTDOWN -> {
                            if (open != null && at > open!!) result.add(Interval(open!!, at))
                            open = null; running = false; active.clear(); interactive = false; unlocked = startupUnlocked; startupPending = true
                        }
                        Kind.STARTUP -> {
                            if (!startupPending) {
                                val checkpoint = minOf(initial.cursor, initial.bootCuts.minOfOrNull { it.checkpoint } ?: initial.cursor)
                                if (open != null && checkpoint > open!!) result.add(Interval(open!!, checkpoint))
                                open = null; active.clear(); interactive = false; unlocked = startupUnlocked
                            }
                            // AOSP stamps this marker at unlock, after queued screen/keyguard events.
                            // Those new-boot gates and resumed activities must survive the marker.
                            startupPending = false; running = true
                        }
                    }
                }
                val working = running && interactive && unlocked && active.any { it.substringBefore('\u0000') in selection }
                if (working && open == null) open = at
                if (!working && open != null) {
                    if (at > open!!) result.add(Interval(open!!, at))
                    open = null
                }
            }
        return Reconstruction(TrackingState(end, active, interactive, unlocked, running, open, startupPending,
            initial.bootCuts.filter { it.at >= end }), union(result))
    }

    fun union(intervals: List<Interval>): List<Interval> {
        val result = mutableListOf<Interval>()
        intervals.filter { it.end > it.start }.sortedBy { it.start }.forEach { next ->
            val last = result.lastOrNull()
            if (last != null && next.start <= last.end) result[result.lastIndex] = Interval(last.start, maxOf(last.end, next.end))
            else result.add(next)
        }
        return result
    }

    fun splitDays(interval: Interval, zone: ZoneId): List<Interval> {
        val result = mutableListOf<Interval>()
        var start = interval.start
        while (start < interval.end) {
            val midnight = Instant.ofEpochMilli(start).atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            val end = minOf(interval.end, midnight)
            result.add(Interval(start, end)); start = end
        }
        return result
    }

    fun id(epoch: String, interval: Interval): String = "android-" + MessageDigest.getInstance("SHA-256")
        .digest("$epoch:${interval.start}:${interval.end}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
