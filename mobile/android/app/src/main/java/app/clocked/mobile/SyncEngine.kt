package app.clocked.mobile

interface DeviceStore { fun read(): DeviceData; fun write(data: DeviceData) }
data class UploadSnapshot(val epoch: String, val origin: String, val token: String, val batch: List<Session>) {
    fun matches(data: DeviceData) = epoch == data.epoch && origin == data.origin && token == data.token
}
sealed interface UploadResult {
    data class Response(val code: Int, val body: String) : UploadResult
    data object Unavailable : UploadResult
}
fun interface PendingUpload { fun await(): UploadResult }
fun interface UploadTransport {
    /** Must only enqueue work, never resolve DNS or wait for the network on this thread. */
    fun start(snapshot: UploadSnapshot): PendingUpload
}

class SyncEngine(private val store: DeviceStore, private val lock: Any, private val transport: UploadTransport,
    private val activeEpochs: MutableSet<String>) {
    fun sync(): Boolean {
        val captured = synchronized(lock) {
            val data = store.read()
            val batch = data.sessions.filter { !it.synced }.take(500)
            if (data.token.isEmpty() || batch.isEmpty()) return true
            UploadSnapshot(data.epoch, data.origin, data.token, batch)
        }
        val upload = synchronized(lock) {
            // Account edits may have happened after capture. Initiation and the account boundary serialize.
            if (!captured.matches(store.read())) return true
            if (!activeEpochs.add(captured.epoch)) return false
            try { transport.start(captured) } catch (_: Exception) { activeEpochs.remove(captured.epoch); return false }
        }
        try {
            val result = try { upload.await() } catch (_: Exception) { UploadResult.Unavailable }
            return synchronized(lock) {
                val data = store.read()
                if (!captured.matches(data)) return@synchronized true
                when (result) {
                    is UploadResult.Response -> if (result.code in 200..299) {
                        try {
                            val accepted = data.acknowledge(result.body, captured.batch)
                            data.status = "Synced $accepted sessions. ${data.sessions.count { !it.synced }} pending."
                        } catch (_: Exception) { data.status = "Invalid server acknowledgment. Pending sessions retained." }
                    } else data.status = when (result.code) {
                        401, 403 -> "Device token rejected. Replace it in connection settings."
                        400, 409 -> "Server rejected pending sessions. Retained for retry."
                        else -> "Sync failed (HTTP ${result.code}). Pending sessions retained."
                    }
                    UploadResult.Unavailable -> data.status = "Sync unavailable or timed out. Pending sessions retained."
                }
                // Rejected rows cannot indefinitely block a later valid batch. IDs and values stay unchanged.
                val sent = captured.batch.map { it.id }.toSet()
                val rejected = data.sessions.filter { !it.synced && it.id in sent }
                data.sessions.removeAll(rejected.toSet()); data.sessions.addAll(rejected)
                store.write(data)
                data.sessions.none { !it.synced }
            }
        } finally { synchronized(lock) { activeEpochs.remove(captured.epoch) } }
    }
}
