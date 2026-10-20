package app.clocked.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

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
        return VaultFormat.decode(bytes, key())
    }

    override fun write(data: DeviceData) {
        val encrypted = VaultFormat.encode(data, key())
        val stream = file.startWrite()
        try { stream.write(encrypted); file.finishWrite(stream) } catch (error: Throwable) { file.failWrite(stream); throw error }
    }
}
