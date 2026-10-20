package app.clocked.mobile

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class HttpUpload(private val client: OkHttpClient = sharedClient, private val waitMillis: Long = 45_000) : UploadTransport {
    companion object {
        private val sharedClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .callTimeout(40, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    }

    override fun start(snapshot: UploadSnapshot): PendingUpload {
        val result = CompletableFuture<UploadResult>()
        val request = Request.Builder().url(snapshot.origin + "/sessions")
            .header("Authorization", "Bearer ${snapshot.token}")
            .post(Protocol.payload(snapshot.batch).toRequestBody("application/json".toMediaType())).build()
        val call = client.newCall(request)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { result.complete(UploadResult.Unavailable) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        val body = response.body?.byteStream()?.use { input ->
                            val output = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(8192)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                require(output.size() + count <= 1_048_576)
                                output.write(buffer, 0, count)
                            }
                            output.toString("UTF-8")
                        }.orEmpty()
                        result.complete(UploadResult.Response(response.code, body))
                    } catch (_: Exception) { result.complete(UploadResult.Unavailable) }
                }
            }
        })
        return PendingUpload {
            // Also bounds the caller if native DNS resolution cannot be interrupted by call cancellation.
            try { result.get(waitMillis, TimeUnit.MILLISECONDS) }
            catch (_: Exception) { call.cancel(); UploadResult.Unavailable }
        }
    }
}
