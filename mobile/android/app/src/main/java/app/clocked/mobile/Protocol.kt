package app.clocked.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant

data class Session(val id: String, val interval: Interval, val timezone: String, val synced: Boolean = false) {
    fun json() = JSONObject().put("id", id).put("start_utc", Instant.ofEpochMilli(interval.start).toString())
        .put("end_utc", Instant.ofEpochMilli(interval.end).toString()).put("start_reason", "app")
        .put("end_reason", "app").put("timezone", timezone)
}

object Protocol {
    fun origin(raw: String): String {
        val uri = URI(raw.trim())
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) {
            "Enter an HTTPS server origin without a path, query, or login."
        }
        return uri.toASCIIString().trimEnd('/')
    }
    fun payload(sessions: List<Session>): String {
        require(sessions.size in 1..500)
        return JSONObject().put("sessions", JSONArray(sessions.map { it.json() })).toString()
    }
    fun accepted(body: String, sent: List<Session>): Set<String> {
        val array = JSONObject(body).getJSONArray("accepted")
        val sentIds = sent.map { it.id }.toSet()
        return (0 until array.length()).map { array.getString(it) }.filter { it in sentIds }.toSet()
    }
}
