package com.ferrumnyak.brotherwatch

// Ускорение YouTube: локальный прокси ByeDPI (его запускает Rust, dpi.rs).
// Через него идут только соединения с доменами YouTube:
// - yt-dlp — опцией --proxy (он работает отдельным процессом);
// - ExoPlayer и прочий HttpURLConnection — через ProxySelector;
// - WebView (интерфейс и «Обзор») — через ProxyController, если система
//   умеет пускать через прокси только выбранные домены.

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.Executor

object DpiProxy {
    private const val TAG = "BrotherHub"

    /// Домены YouTube (вместе с поддоменами) — как HOSTS в dpi.rs.
    private val HOSTS = listOf(
        "youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "ggpht.com",
        "youtube-nocookie.com", "youtubei.googleapis.com",
    )

    /// `http://127.0.0.1:порт` или null — обход выключен.
    @Volatile
    var url: String? = null
        private set

    @Volatile
    private var address: InetSocketAddress? = null

    private var installed = false

    fun isYoutube(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return HOSTS.any { h == it || h.endsWith(".$it") }
    }

    /// Новый прокси от Rust (null — выключить).
    fun set(proxy: String?) {
        val uri = proxy?.let { runCatching { URI(it) }.getOrNull() }
        address = uri?.let { InetSocketAddress.createUnresolved(it.host, it.port) }
        url = if (address != null) proxy else null
        Log.i(TAG, "прокси обхода: ${url ?: "выключен"}")
        installSelector()
        Handler(Looper.getMainLooper()).post { applyWebView() }
    }

    /// Добавить yt-dlp прокси, если обход включён.
    fun apply(request: YoutubeDLRequest): YoutubeDLRequest {
        url?.let { request.addOption("--proxy", it) }
        return request
    }

    @Synchronized
    private fun installSelector() {
        if (installed) return
        installed = true
        val system = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI?): List<Proxy> {
                val a = address
                if (a != null && isYoutube(uri?.host)) return listOf(Proxy(Proxy.Type.HTTP, a))
                return system?.select(uri) ?: listOf(Proxy.NO_PROXY)
            }

            override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
                system?.connectFailed(uri, sa, ioe)
            }
        })
    }

    private fun applyWebView() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return
        val controller = ProxyController.getInstance()
        val run = Executor { it.run() }
        val a = address
        // Без «обратного» списка через прокси пошло бы всё, включая сервер
        // зала и голос, — тогда WebView оставляем без прокси.
        if (a == null || !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)) {
            controller.clearProxyOverride(run) {}
            return
        }
        val config = ProxyConfig.Builder()
            .addProxyRule("${a.hostString}:${a.port}")
        for (h in HOSTS) {
            config.addBypassRule(h)
            config.addBypassRule("*.$h")
        }
        config.setReverseBypassEnabled(true)
        try {
            controller.setProxyOverride(config.build(), run) {}
        } catch (e: Throwable) {
            Log.w(TAG, "WebView не принял прокси обхода", e)
        }
    }
}
