package com.ferrumnyak.brotherwatch

// Плеер BrotherHub на Android.
//
// Rust-часть (player_android.rs) говорит с плеером теми же строками, что и
// с mpv на компьютере (JSON IPC): loadfile, seek, set_property, get_property.
// Здесь эти строки выполняются на ExoPlayer, а ответы и события
// (property-change, file-loaded, playback-restart, end-file) копятся в
// очереди, которую Rust забирает долгим опросом `poll`.
//
// Картинка лежит ПОД прозрачным WebView: интерфейс сообщает прямоугольник
// области видео (`rect`), и плеер встаёт ровно туда. Поэтому кнопки, чат и
// реакции интерфейса рисуются поверх видео как обычно.
//
// Ссылки на страницы (YouTube, VK, SoundCloud…) разбирает yt-dlp, который
// лежит внутри APK (библиотека youtubedl-android).

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

private const val TAG = "BrotherHub"

/// Фон «зала» — виден там, где нет ни интерфейса, ни видео.
private const val HALL = 0xFF0F0D10.toInt()

@InvokeArg
class StartArgs {
    var player: Long = 0
    var format: String? = null
}

@InvokeArg
class PollArgs {
    var player: Long = 0
}

@InvokeArg
class SendArgs {
    var player: Long = 0
    var lines: Array<String> = arrayOf()
}

@InvokeArg
class RectArgs {
    var visible: Boolean = false
    var x: Int = 0
    var y: Int = 0
    var width: Int = 0
    var height: Int = 0
}

@InvokeArg
class KeepAliveArgs {
    var room: String? = null
    var mic: Boolean = false
}

@InvokeArg
class FullscreenArgs {
    var on: Boolean = false
}

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    /// yt-dlp работает долго — отдельным потоком, по одной ссылке за раз.
    private val worker = Executors.newSingleThreadExecutor()

    private var webView: WebView? = null
    private var view: PlayerView? = null
    private var exo: ExoPlayer? = null

    /// Номер плеера у Rust; сменился — старый опрос получает alive=false.
    private var playerId = 0L
    private val out = ArrayDeque<String>()
    private var waiting: Invoke? = null
    private var waitingFor = 0L

    // То, что в mpv было бы свойствами.
    private var format = "best"
    private var startAt: Double? = null
    private var mediaTitle: String? = null
    private var ytdlJson: String? = null
    private var currentUrl: String? = null
    /// Номер загрузки: ответ yt-dlp для старой ссылки выбрасываем.
    private var loadToken = 0
    /// Ждём готовности после loadfile, чтобы прислать file-loaded.
    private var loading = false
    private var ytdlReady = false
    /// Ссылка-приглашение brotherhub://…, которую интерфейс ещё не забрал.
    private var pendingLink: String? = null
    /// Где видео в интерфейсе (чтобы вернуть его после «картинки в картинке»).
    private var lastRect: RectArgs? = null
    private var inPip = false
    private var asked = false

    override fun load(webView: WebView) {
        instance = this
        this.webView = webView
        keepLink(activity.intent)
        // Интерфейс прозрачный: под ним — видео.
        webView.setBackgroundColor(Color.TRANSPARENT)
        activity.window.setBackgroundDrawable(ColorDrawable(HALL))
        worker.execute {
            try {
                YoutubeDL.getInstance().init(activity.applicationContext)
                ytdlReady = true
                updateYtdlp(activity.applicationContext)
            } catch (e: Throwable) {
                Log.e(TAG, "yt-dlp не запустился", e)
            }
        }
    }

    // Приложение уже открыто, а друг прислал ещё ссылку.
    override fun onNewIntent(intent: Intent) {
        keepLink(intent)
    }

    private fun keepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "brotherhub") pendingLink = data.toString()
    }

    /// Забрать ссылку-приглашение (один раз).
    @Command
    fun takeLink(invoke: Invoke) {
        main.post {
            val link = pendingLink
            pendingLink = null
            invoke.resolve(JSObject().apply { put("link", link) })
        }
    }

    // ---------- Команды от Rust ----------

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        main.post {
            ensurePlayer()
            playerId = args.player
            args.format?.let { format = it }
            out.clear()
            // Старый опрос завершаем: тот плеер закрыт.
            flush(force = true)
            invoke.resolve()
        }
    }

    @Command
    fun poll(invoke: Invoke) {
        val args = invoke.parseArgs(PollArgs::class.java)
        main.post {
            if (args.player != playerId) {
                invoke.resolve(JSObject().apply {
                    put("lines", JSArray())
                    put("alive", false)
                })
                return@post
            }
            waiting?.let { resolvePoll(it, emptyList()) }
            waiting = invoke
            waitingFor = args.player
            if (out.isNotEmpty()) {
                flush()
            } else {
                // Ничего нет — ответим пустым через секунду, Rust спросит снова.
                main.postDelayed({ if (waiting === invoke) flush(force = true) }, 1000)
            }
        }
    }

    @Command
    fun send(invoke: Invoke) {
        val args = invoke.parseArgs(SendArgs::class.java)
        invoke.resolve()
        main.post {
            if (args.player != playerId) return@post
            for (line in args.lines) {
                try {
                    handle(JSONObject(line))
                } catch (e: Throwable) {
                    Log.w(TAG, "команда плеера: $line", e)
                }
            }
            flush()
        }
    }

    @Command
    fun rect(invoke: Invoke) {
        val args = invoke.parseArgs(RectArgs::class.java)
        invoke.resolve()
        main.post { place(args) }
    }

    @Command
    fun fullscreen(invoke: Invoke) {
        val args = invoke.parseArgs(FullscreenArgs::class.java)
        invoke.resolve()
        main.post {
            val window = activity.window
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            if (args.on) {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    // ---------- Фон и «картинка в картинке» ----------

    /// Пока ты в зале (`room`), приложение работает и свёрнутым:
    /// служба с уведомлением (PlaybackService). `room = null` — вышел.
    @Command
    fun keepAlive(invoke: Invoke) {
        val args = invoke.parseArgs(KeepAliveArgs::class.java)
        invoke.resolve()
        main.post {
            val intent = Intent(activity, PlaybackService::class.java)
            val room = args.room
            if (room == null) {
                activity.stopService(intent)
                return@post
            }
            // Android 13+: уведомление показывается только с разрешения.
            if (Build.VERSION.SDK_INT >= 33 && !asked) {
                asked = true
                activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 41)
            }
            intent.putExtra(PlaybackService.EXTRA_ROOM, room)
            intent.putExtra(PlaybackService.EXTRA_MIC, args.mic)
            try {
                if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent)
                else activity.startService(intent)
            } catch (e: Throwable) {
                Log.w(TAG, "служба для фона не запустилась", e)
            }
        }
    }

    /// Кнопка «картинка в картинке».
    @Command
    fun pip(invoke: Invoke) {
        invoke.resolve()
        main.post { enterPip() }
    }

    private fun hasVideo(): Boolean =
        exo?.currentTracks?.groups?.any { it.type == C.TRACK_TYPE_VIDEO } == true

    private fun pipParams(auto: Boolean): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < 26) return null
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(auto)
        return b.build()
    }

    /// Android 12+: сам уходит в «картинку в картинке», если видео идёт.
    private fun updatePip() {
        if (Build.VERSION.SDK_INT < 31) return
        val auto = exo?.isPlaying == true && hasVideo()
        try {
            pipParams(auto)?.let { activity.setPictureInPictureParams(it) }
        } catch (e: Throwable) {
            Log.w(TAG, "картинка в картинке недоступна", e)
        }
    }

    private fun enterPip() {
        if (Build.VERSION.SDK_INT < 26 || !hasVideo()) return
        try {
            pipParams(exo?.isPlaying == true)?.let { activity.enterPictureInPictureMode(it) }
        } catch (e: Throwable) {
            Log.w(TAG, "картинка в картинке недоступна", e)
        }
    }

    /// Android до 12: уходим в «картинку в картинке» сами, когда свернули.
    fun onUserLeave() {
        if (Build.VERSION.SDK_INT < 31 && exo?.isPlaying == true) enterPip()
    }

    /// В маленьком окне — только видео, без интерфейса.
    fun onPip(on: Boolean) {
        inPip = on
        val v = view ?: return
        if (on) {
            webView?.visibility = View.INVISIBLE
            v.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            v.visibility = View.VISIBLE
        } else {
            webView?.visibility = View.VISIBLE
            lastRect?.let { place(it) }
        }
    }

    // ---------- Очередь ответов ----------

    private fun emit(obj: JSONObject) {
        out.addLast(obj.toString())
    }

    private fun event(name: String, extra: (JSONObject) -> Unit = {}) {
        emit(JSONObject().put("event", name).also(extra))
    }

    private fun flush(force: Boolean = false) {
        val invoke = waiting ?: return
        if (out.isEmpty() && !force) return
        val lines = out.toList()
        out.clear()
        waiting = null
        resolvePoll(invoke, lines)
    }

    private fun resolvePoll(invoke: Invoke, lines: List<String>) {
        val arr = JSArray()
        lines.forEach { arr.put(it) }
        invoke.resolve(JSObject().apply {
            put("lines", arr)
            put("alive", waitingFor == playerId)
        })
    }

    // ---------- Команды в духе mpv ----------

    private fun handle(msg: JSONObject) {
        val requestId = msg.optLong("request_id", -1)
        val command = msg.opt("command")
        var reply: Any? = null
        var ok = true
        if (command is JSONArray && command.length() > 0) {
            when (command.getString(0)) {
                "get_property" -> {
                    val value = property(command.getString(1))
                    if (value == null) ok = false else reply = value
                }
                "set_property" -> setProperty(command.getString(1), command.opt(2))
                "loadfile" -> loadFile(command.getString(1))
                "seek" -> seek(command.optDouble(1, 0.0), command.optString(2, "absolute"))
                "stop" -> stop()
                "quit" -> stop()
                // Смена качества: открыть ту же ссылку заново.
                "playlist-play-index" -> currentUrl?.let { loadFile(it) }
                // Остальное (дорожки, субтитры, наблюдение за свойствами)
                // на телефоне пока не нужно.
                else -> {}
            }
        }
        if (requestId >= 0) {
            val r = JSONObject()
                .put("request_id", requestId)
                .put("error", if (ok) "success" else "property unavailable")
            if (ok && reply != null) r.put("data", reply)
            emit(r)
        }
    }

    private fun property(name: String): Any? {
        val p = exo ?: return null
        val loaded = p.mediaItemCount > 0
        return when (name) {
            "time-pos" -> if (loaded) p.currentPosition / 1000.0 else null
            "duration" -> if (loaded && p.duration != C.TIME_UNSET) p.duration / 1000.0 else null
            "volume" -> (p.volume * 100.0).toDouble()
            "speed" -> p.playbackParameters.speed.toDouble()
            "pause" -> !p.playWhenReady
            "media-title" -> mediaTitle ?: currentUrl
            "eof-reached" -> loaded && p.playbackState == Player.STATE_ENDED
            "track-list" -> JSONArray()
            "current-tracks/video" ->
                if (p.currentTracks.groups.any { it.type == C.TRACK_TYPE_VIDEO }) JSONObject() else null
            "user-data/mpv/ytdl/json-subprocess-result" ->
                ytdlJson?.let { JSONObject().put("stdout", it) }
            else -> null
        }
    }

    private fun setProperty(name: String, value: Any?) {
        val p = exo ?: return
        when (name) {
            "pause" -> p.playWhenReady = !(value as? Boolean ?: true)
            "speed" -> (value as? Number)?.let { p.setPlaybackSpeed(it.toFloat()) }
            "volume" -> (value as? Number)?.let { p.volume = (it.toFloat() / 100f).coerceIn(0f, 1f) }
            "start" -> startAt = (value as? String)?.toDoubleOrNull() ?: (value as? Number)?.toDouble()
            "ytdl-format" -> (value as? String)?.let { format = it }
            "force-media-title" -> (value as? String)?.let { mediaTitle = it.ifEmpty { null } }
            else -> {}
        }
    }

    private fun seek(value: Double, mode: String) {
        val p = exo ?: return
        val target = if (mode == "relative") p.currentPosition + (value * 1000).toLong() else (value * 1000).toLong()
        p.seekTo(target.coerceAtLeast(0))
    }

    private fun stop() {
        loadToken++
        loading = false
        currentUrl = null
        mediaTitle = null
        ytdlJson = null
        exo?.stop()
        exo?.clearMediaItems()
    }

    // ---------- Открытие ссылок ----------

    private fun loadFile(url: String) {
        ensurePlayer()
        val token = ++loadToken
        currentUrl = url
        ytdlJson = null
        loading = true
        val pageLink = url.startsWith("http://") || url.startsWith("https://")
        if (!pageLink) {
            // Файл с телефона (content://…) или прямой поток.
            play(token, listOf(Stream(url, null, emptyMap())))
            return
        }
        val fmt = format
        worker.execute {
            val result = try {
                resolve(url, fmt)
            } catch (e: Throwable) {
                Log.w(TAG, "yt-dlp не разобрал $url", e)
                null
            }
            main.post {
                if (token != loadToken) return@post
                if (result == null) {
                    // Не разобрали — может, это прямая ссылка на поток.
                    if (looksLikeStream(url)) {
                        play(token, listOf(Stream(url, null, emptyMap())))
                    } else {
                        loading = false
                        event("end-file") { it.put("reason", "error") }
                        flush()
                    }
                    return@post
                }
                ytdlJson = result.json
                if (mediaTitle == null) mediaTitle = result.title
                play(token, result.streams)
            }
        }
    }

    private data class Stream(val url: String, val protocol: String?, val headers: Map<String, String>)

    private data class Resolved(val streams: List<Stream>, val title: String?, val json: String)

    private fun resolve(url: String, fmt: String): Resolved? {
        if (!ytdlReady) {
            YoutubeDL.getInstance().init(activity.applicationContext)
            ytdlReady = true
        }
        val request = YoutubeDLRequest(url)
        request.addOption("--no-warnings")
        request.addOption("--no-playlist")
        request.addOption("-J")
        request.addOption("-f", fmt)
        val response = YoutubeDL.getInstance().execute(request)
        val json = response.out
        val info = JSONObject(json)
        val formats = info.optJSONArray("requested_formats")
        val list = mutableListOf<JSONObject>()
        if (formats != null && formats.length() > 0) {
            for (i in 0 until formats.length()) list.add(formats.getJSONObject(i))
        } else {
            list.add(info)
        }
        val streams = list.mapNotNull { f ->
            val link = f.optString("url", "")
            if (link.isEmpty()) return@mapNotNull null
            val headers = mutableMapOf<String, String>()
            f.optJSONObject("http_headers")?.let { h ->
                h.keys().forEach { k -> headers[k] = h.optString(k) }
            }
            Stream(link, f.optString("protocol", ""), headers)
        }
        if (streams.isEmpty()) return null
        return Resolved(streams, info.optString("title").ifEmpty { null }, json)
    }

    private fun looksLikeStream(url: String): Boolean {
        val path = Uri.parse(url).path?.lowercase() ?: return false
        return listOf(".m3u8", ".mp4", ".mkv", ".webm", ".mp3", ".m4a", ".mpd").any { path.endsWith(it) }
    }

    private fun play(token: Int, streams: List<Stream>) {
        if (token != loadToken) return
        val p = ensurePlayer()
        val sources: List<MediaSource> = streams.map { s -> source(s) }
        val source = if (sources.size == 1) sources[0] else MergingMediaSource(*sources.toTypedArray())
        p.setMediaSource(source)
        startAt?.let { p.seekTo((it * 1000).toLong()) }
        p.prepare()
    }

    private fun source(s: Stream): MediaSource {
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(20000)
        s.headers["User-Agent"]?.let { http.setUserAgent(it) }
        val rest = s.headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) }
        if (rest.isNotEmpty()) http.setDefaultRequestProperties(rest)
        val factory = DefaultMediaSourceFactory(DefaultDataSource.Factory(activity, http))
        val item = MediaItem.Builder().setUri(Uri.parse(s.url))
        val proto = s.protocol ?: ""
        if (proto.contains("m3u8") || s.url.contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        return factory.createMediaSource(item.build())
    }

    // ---------- Плеер и картинка ----------

    private fun ensurePlayer(): ExoPlayer {
        exo?.let { return it }
        val p = ExoPlayer.Builder(activity)
            // Голосовой чат и наушники не должны ставить фильм на паузу у всех.
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                false
            )
            .setHandleAudioBecomingNoisy(false)
            .build()
        p.playWhenReady = false
        p.addListener(object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                event("property-change") { it.put("name", "pause").put("data", !playWhenReady) }
                flush()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                view?.keepScreenOn = isPlaying
                updatePip()
            }

            override fun onPlaybackStateChanged(state: Int) {
                when (state) {
                    Player.STATE_READY -> {
                        if (loading) {
                            loading = false
                            event("file-loaded")
                            event("playback-restart")
                        }
                    }
                    // Как mpv с keep-open: в конце встаём на паузу.
                    Player.STATE_ENDED -> exo?.playWhenReady = false
                    else -> {}
                }
                flush()
            }

            // Перемотка — как playback-restart у mpv.
            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int
            ) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK && !loading) {
                    event("playback-restart")
                    flush()
                }
            }

            override fun onTracksChanged(tracks: Tracks) {
                event("property-change") { it.put("name", "track-list") }
                flush()
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "плеер не смог открыть $currentUrl", error)
                loading = false
                event("end-file") { it.put("reason", "error") }
                flush()
            }
        })
        exo = p

        val v = PlayerView(activity)
        v.useController = false
        v.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
        v.setShutterBackgroundColor(Color.BLACK)
        v.setBackgroundColor(Color.BLACK)
        v.player = p
        v.visibility = View.GONE
        // Под WebView: в тот же контейнер, первым.
        val parent = webView?.parent as? ViewGroup
        if (parent != null) {
            parent.addView(v, 0, FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.START))
        } else {
            activity.addContentView(v, FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.START))
            webView?.bringToFront()
        }
        view = v
        return p
    }

    private fun place(r: RectArgs) {
        lastRect = r
        if (inPip) return
        val v = view ?: run {
            if (!r.visible) return
            ensurePlayer()
            view ?: return
        }
        if (!r.visible || r.width <= 0 || r.height <= 0) {
            v.visibility = View.GONE
            return
        }
        val left = (webView?.left ?: 0) + r.x
        val top = (webView?.top ?: 0) + r.y
        val lp = (v.layoutParams as? FrameLayout.LayoutParams)
            ?: FrameLayout.LayoutParams(r.width, r.height)
        lp.width = r.width
        lp.height = r.height
        lp.gravity = Gravity.TOP or Gravity.START
        lp.leftMargin = left
        lp.topMargin = top
        v.layoutParams = lp
        v.visibility = View.VISIBLE
    }

    // ---------- Обновление yt-dlp ----------

    /// Сайты часто меняются — встроенный yt-dlp обновляем при каждом
    /// запуске. Название канала обновлений в разных версиях библиотеки
    /// разное, поэтому ищем его без жёсткой привязки.
    private fun updateYtdlp(context: Context) {
        try {
            val ydl = YoutubeDL.getInstance()
            val method = ydl.javaClass.methods.firstOrNull {
                it.name == "updateYoutubeDL" && it.parameterTypes.size == 2
            } ?: return
            val type = method.parameterTypes[1]
            val channel: Any = type.enumConstants?.firstOrNull { it.toString().contains("STABLE") }
                ?: type.declaredClasses.firstOrNull { it.simpleName.contains("STABLE") }
                    ?.getField("INSTANCE")?.get(null)
                ?: type.declaredFields.firstOrNull { it.name.contains("STABLE") }
                    ?.also { it.isAccessible = true }?.get(null)
                ?: return
            method.invoke(ydl, context, channel)
            Log.i(TAG, "yt-dlp обновлён")
        } catch (e: Throwable) {
            Log.w(TAG, "yt-dlp не обновился", e)
        }
    }

    companion object {
        /// Для MainActivity: «картинка в картинке» приходит туда.
        var instance: PlayerPlugin? = null
    }
}
