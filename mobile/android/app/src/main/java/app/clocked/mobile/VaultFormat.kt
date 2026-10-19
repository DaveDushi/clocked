package app.clocked.mobile

import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The same authenticated envelope is used by Android storage and process-restart JVM fixtures. */
object VaultFormat {
    fun decode(bytes: ByteArray, key: SecretKey): DeviceData {
        require(bytes.size > 28) { "Encrypted storage is damaged. Clear app storage to reconnect." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        val s = json.getJSONObject("state")
        val data = DeviceData(json.getString("origin"), json.getString("token"), json.getString("epoch"),
            strings(json.getJSONArray("selected")), TrackingState(s.getLong("cursor"), strings(s.getJSONArray("active")),
                s.getBoolean("interactive"), s.getBoolean("unlocked"), s.getBoolean("running"), if (s.isNull("open")) null else s.getLong("open"), s.optBoolean("startupPending", !s.getBoolean("running")), bootCuts(s.optJSONArray("bootCuts"))),
            json.getString("zone"), json.getBoolean("permission"), json.getInt("boot"), json.getLong("wall"), json.getLong("elapsed"), json.getString("status"))
        val rows = json.getJSONArray("sessions")
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            data.sessions.add(Session(row.getString("id"), Interval(row.getLong("start"), row.getLong("end")), row.getString("zone"), row.getBoolean("synced")))
        }
        json.optJSONArray("selections")?.let { changes -> for (i in 0 until changes.length()) {
            val change = changes.getJSONObject(i); data.selections.add(SelectionChange(change.getLong("at"), strings(change.getJSONArray("packages"))))
        } }
        json.optJSONArray("zones")?.let { changes -> for (i in 0 until changes.length()) {
            val change = changes.getJSONObject(i); data.zones.add(ZoneChange(change.getLong("at"), change.getString("zone")))
        } }
        data.boundaryNotice = json.optString("boundaryNotice", "")
        data.eventOffset = json.optLong("eventOffset", 0)
        json.optJSONArray("eventMarks")?.let { marks -> for (i in 0 until marks.length()) {
            val mark = marks.getJSONObject(i); data.eventMarks.add(EventMark(mark.getLong("at"), mark.getString("signature")))
        } }
        return data
    }

    fun encode(data: DeviceData, key: SecretKey): ByteArray {
        val s = data.state
        val json = JSONObject().put("origin", data.origin).put("token", data.token).put("epoch", data.epoch)
            .put("selected", JSONArray(data.selected.toList())).put("zone", data.zone).put("permission", data.permission)
            .put("boot", data.boot).put("wall", data.wall).put("elapsed", data.elapsed).put("status", data.status)
            .put("boundaryNotice", data.boundaryNotice)
            .put("eventOffset", data.eventOffset)
            .put("eventMarks", JSONArray(data.eventMarks.map { JSONObject().put("at", it.at).put("signature", it.signature) }))
            .put("selections", JSONArray(data.selections.map { JSONObject().put("at", it.at).put("packages", JSONArray(it.packages.toList())) }))
            .put("zones", JSONArray(data.zones.map { JSONObject().put("at", it.at).put("zone", it.zone) }))
            .put("state", JSONObject().put("cursor", s.cursor).put("active", JSONArray(s.active.toList()))
                .put("interactive", s.interactive).put("unlocked", s.unlocked).put("running", s.running).put("open", s.open ?: JSONObject.NULL).put("startupPending", s.startupPending).put("bootCuts", JSONArray(s.bootCuts.map { JSONObject().put("boot", it.boot).put("at", it.at).put("checkpoint", it.checkpoint) })))
            .put("sessions", JSONArray(data.sessions.map { JSONObject().put("id", it.id).put("start", it.interval.start)
                .put("end", it.interval.end).put("zone", it.timezone).put("synced", it.synced) }))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        return cipher.iv + cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
    }
    private fun bootCuts(array: JSONArray?): List<BootCut> = if (array == null) emptyList() else
        (0 until array.length()).map { index -> array.getJSONObject(index).let { BootCut(it.getInt("boot"), it.getLong("at"), it.getLong("checkpoint")) } }
    private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }.toSet()
}