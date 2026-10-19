package app.clocked.mobile

import org.junit.Assert.*
import org.junit.Test

class AccountQueueTest {
    private val first = Session("android-first", Interval(10, 20), "UTC")
    private val second = Session("android-second", Interval(30, 40), "UTC")

    @Test fun changedAccountCannotInheritQueuedUsageOrAnOpenSession() {
        val previous = DeviceData(origin = "https://a.example", token = "clk_account_a", epoch = "old-epoch",
            selected = setOf("local.work.app"), state = TrackingState(15, setOf("local.work.app\u0000Main"), true, true, true, 10),
            sessions = mutableListOf(first))
        val next = previous.withConnection("https://a.example", "clk_account_b")
        assertEquals("clk_account_b", next.token)
        assertEquals(emptyList<Session>(), next.sessions)
        assertNull(next.state.open)
        assertTrue(next.state.active.isEmpty())
        assertNotEquals("old-epoch", next.epoch)
        assertEquals(setOf("local.work.app"), next.selected)
        assertEquals(emptyList<Session>(), previous.withConnection("https://b.example", "clk_account_a").sessions)
    }

    @Test fun unchangedConnectionPreservesStableRetryIdsAndPendingQueue() {
        val previous = DeviceData(origin = "https://a.example", token = "clk_same_account", sessions = mutableListOf(first))
        val next = previous.withConnection("https://a.example", "clk_same_account")
        assertSame(previous, next)
        assertEquals(listOf(first), next.sessions.filter { !it.synced })
    }

    @Test fun onlySentAndAcknowledgedIdsLeaveThePendingQueue() {
        val data = DeviceData(sessions = mutableListOf(first, second))
        data.acknowledge("""{"accepted":["android-first","android-second","foreign"]}""", listOf(first))
        assertEquals(listOf(first.copy(synced = true), second), data.sessions)
        assertEquals(listOf(second), data.sessions.filter { !it.synced })
        data.acknowledge("""{"accepted":[]}""", listOf(second))
        assertEquals(listOf(second), data.sessions.filter { !it.synced })
        data.acknowledge("""{"accepted":["android-second"]}""", listOf(second))
        assertTrue(data.sessions.all { it.synced })
    }

    @Test fun malformedAcknowledgmentLeavesQueueUntouched() {
        val data = DeviceData(sessions = mutableListOf(first, second))
        try { data.acknowledge("invalid json", listOf(first, second)); fail("Malformed response accepted") }
        catch (_: org.json.JSONException) { }
        assertEquals(listOf(first, second), data.sessions)
    }
}
