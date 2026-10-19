package app.clocked.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class DeviceData(
    var origin: String = "", var token: String = "", var epoch: String = UUID.randomUUID().toString(),
    var selected: Set<String> = emptySet(), var state: TrackingState = TrackingState(0),
    var zone: String = java.time.ZoneId.systemDefault().id,
    var permission: Boolean = false, var boot: Int = -1,
    var wall: Long = 0, var elapsed: Long = 0, var status: String = "Connect your Clocked account to start.",
    val sessions: MutableList<Session> = mutableListOf(),
    val selections: MutableList<SelectionChange> = mutableListOf(),
    val zones: MutableList<ZoneChange> = mutableListOf(),
    var boundaryNotice: String = "",
    val eventMarks: MutableList<EventMark> = mutableListOf(),
    var eventOffset: Long = 0,
) {
    fun withConnection(server: String, credential: String): DeviceData =
        if (origin == server && token == credential) this
        else DeviceData(origin = server, token = credential, selected = selected)

    fun acknowledge(body: String, batch: List<Session>): Int {
        val accepted = Protocol.accepted(body, batch)
        sessions.replaceAll { if (it.id in accepted) it.copy(synced = true) else it }
        return accepted.size
    }
}

class Vault(context: Context) : DeviceStore {
    private val file = AtomicFile(File(context.noBackupFilesDir, "clocked-v1.enc"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("clocked-v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("clocked-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    override fun read(): DeviceData {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return DeviceData()
        val bytes = file.openRead().use { it.readBytes() }
        require(bytes.size > 28) { "Encrypted storage is damaged. Clear app storage to reconnect." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        val s = json.getJSONObject("state")
        val data = DeviceData(json.getString("origin"), json.getString("token"), json.getString("epoch"),
            strings(json.getJSONArray("selected")), TrackingState(s.getLong("cursor"), strings(s.getJSONArray("active")),
                s.getBoolean("interactive"), s.getBoolean("unlocked"), s.getBoolean("running"), if (s.isNull("open")) null else s.getLong("open"), s.optBoolean("startupPending", !s.getBoolean("running"))),
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

    override fun write(data: DeviceData) {
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
                .put("interactive", s.interactive).put("unlocked", s.unlocked).put("running", s.running).put("open", s.open ?: JSONObject.NULL).put("startupPending", s.startupPending))
            .put("sessions", JSONArray(data.sessions.map { JSONObject().put("id", it.id).put("start", it.interval.start)
                .put("end", it.interval.end).put("zone", it.timezone).put("synced", it.synced) }))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.iv + cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(encrypted); file.finishWrite(stream) } catch (error: Throwable) { file.failWrite(stream); throw error }
    }
    private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }.toSet()
}
