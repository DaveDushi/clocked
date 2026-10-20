package app.clocked.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    private val sent = listOf(Session("android-session-a", Interval(0, 1000), "Europe/Berlin"), Session("android-session-b", Interval(1000, 2000), "UTC"))
    @Test fun wireFormatUsesExactInstantsAndExistingEndpointContract() {
        val payload = JSONObject(Protocol.payload(sent)).getJSONArray("sessions")
        assertEquals(2, payload.length())
        val first = payload.getJSONObject(0)
        assertEquals(setOf("id", "start_utc", "end_utc", "start_reason", "end_reason", "timezone"), first.keys().asSequence().toSet())
        assertEquals("1970-01-01T00:00:00Z", first.getString("start_utc"))
        assertEquals("1970-01-01T00:00:01Z", first.getString("end_utc"))
        assertEquals("Europe/Berlin", first.getString("timezone"))
        assertEquals("app", first.getString("start_reason"))
        assertEquals("app", first.getString("end_reason"))
    }
    @Test fun partialAcknowledgmentNeverLosesUnacceptedSessions() {
        assertEquals(setOf("android-session-b"), Protocol.accepted("""{"accepted":["android-session-b","foreign-id","android-session-b"]}""", sent))
        assertEquals(emptySet<String>(), Protocol.accepted("""{"accepted":[]}""", sent))
    }
    @Test(expected = Exception::class) fun malformedSuccessIsNotAnAcknowledgment() { Protocol.accepted("""{"ok":true}""", sent) }
    @Test(expected = IllegalArgumentException::class) fun batchCannotExceedServerLimit() { Protocol.payload(List(501) { sent.first() }) }
    @Test fun originRequiresHttpsAndCannotLeakSecretsOrRedirectPaths() {
        assertEquals("https://clocked.example", Protocol.origin(" https://clocked.example/ "))
        listOf("http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=abc", "https://example.com/#x").forEach {
            try { Protocol.origin(it); fail("Accepted invalid origin") } catch (_: IllegalArgumentException) { }
        }
    }
}
