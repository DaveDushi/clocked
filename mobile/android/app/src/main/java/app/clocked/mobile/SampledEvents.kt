package app.clocked.mobile

import kotlin.math.abs

/** A query can itself trigger AOSP's history rewrite. Do not consume it with a stale clock sample. */
class SampledEvents(private val before: PlatformSnapshot, private val source: EventSource,
    private val current: () -> PlatformSnapshot) : EventSource {
    var changedDuringQuery: Boolean = false
        private set
    override fun query(begin: Long, end: Long): List<UsageEvent>? {
        val events = source.query(begin, end)
        val after = current()
        changedDuringQuery = after.boot != before.boot || after.elapsed < before.elapsed ||
            abs((after.now - before.now) - (after.elapsed - before.elapsed)) > 250 || after.allowed != before.allowed
        return if (changedDuringQuery) null else events
    }
}
