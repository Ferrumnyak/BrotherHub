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
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.util.Rational
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.InputMethodManager
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

private const val TAG = "BrotherHub"

/// СДВГ-режим: какие ролики брать, как часто искать заново, сколько живёт ссылка.
private const val SIDE_FORMAT = "bestvideo[height<=?480][vcodec!^=av01]/best[height<=?480]/best"
private const val SIDE_LIST_TTL_MS = 3L * 24 * 60 * 60 * 1000
private const val SIDE_LINK_TTL_MS = 3L * 60 * 60 * 1000
private val ID_RE = Regex("^[A-Za-z0-9_-]{11}$")

/// Фон «зала» — виден там, где нет ни интерфейса, ни видео.
private const val HALL = 0xFF0F0D10.toInt()

@InvokeArg
class StartArgs {
    var player: Long = 0
    var format: String? = null
}

@InvokeArg
class ProxyArgs {
    var proxy: String? = null
}

@InvokeArg
class YtdlStreamArgs {
    var url: String = ""
    var format: String = "best"
    var proxy: String? = null
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
class Area {
    var x: Int = 0
    var y: Int = 0
    var width: Int = 0
    var height: Int = 0
}

@InvokeArg
class BrowserOpenArgs {
    var url: String = ""
    var rect: Area? = null
    var script: String? = null
}

@InvokeArg
class BrowserPlaceArgs {
    var rect: Area? = null
}

@InvokeArg
class AdhdArgs {
    var queries: Array<String> = arrayOf()
}

@InvokeArg
class InstallArgs {
    var url: String = ""
}

@InvokeArg
class KeepAliveArgs {
    var room: String? = null
    var mic: Boolean = false
}

@InvokeArg
class RemoteMicArgs {
    var on: Boolean = false
}

@InvokeArg
class BackgroundArgs {
    var color: String = "#0f0d10"
}

@InvokeArg
class FullscreenArgs {
    var on: Boolean = false
    /// Закрепить альбомную ориентацию (кнопка). Без этого — полный экран
    /// от поворота телефона: повернул обратно — вышел.
    var lock: Boolean = true
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
    @Volatile
    private var loadToken = 0
    /// Процесс yt-dlp, который сейчас разбирает ссылку (чтобы остановить его,
    /// если включили другое видео).
    private var loadProcess: String? = null
    /// Ждём готовности после loadfile, чтобы прислать file-loaded.
    private var loading = false
    private var ytdlReady = false
    /// Ссылка-приглашение brotherhub://…, которую интерфейс ещё не забрал.
    private var pendingLink: String? = null
    /// Где видео в интерфейсе (чтобы вернуть его после «картинки в картинке»).
    private var lastRect: RectArgs? = null
    private var inPip = false
    /// СДВГ-режим: второй плеер без звука рядом с фильмом.
    private var sideExo: ExoPlayer? = null
    private var sideView: PlayerView? = null
    private val sideQueue = ArrayDeque<String>()
    private var sideAll = listOf<String>()
    private var sideToken = 0
    /// «Обзор»: сайт в своём WebView поверх области видео.
    private var browser: WebView? = null
    private var browserScript: String? = null
    private var asked = false
    /// Подключён голосовой чат: Android переводит звук в «режим звонка».
    private var voiceOn = false

    override fun load(webView: WebView) {
        instance = this
        this.webView = webView
        keepLink(activity.intent)
        if (isTv()) {
            keepNormalAudioMode()
            // Звук интерфейса (голоса друзей, микрофон пульта через Web Audio)
            // без «сначала нажми»: кнопка микрофона пульта до WebView не
            // доходит, и AudioContext иначе остался бы спящим.
            webView.settings.mediaPlaybackRequiresUserGesture = false
        }
        // Интерфейс прозрачный: под ним — видео.
        webView.setBackgroundColor(Color.TRANSPARENT)
        // Фокус — интерфейсу: на ТВ иначе стрелки пульта никуда не попадают.
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        main.post { webView.requestFocus() }
        activity.window.setBackgroundDrawable(ColorDrawable(HALL))
        worker.execute {
            try {
                ensureYtdl()
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
                activity.requestedOrientation =
                    if (args.lock) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                controller.systemBarsBehavior =
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsetsCompat.Type.systemBars())
            } else {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    /// Отступы под вырез камеры и полоску жестов, в CSS-пикселях.
    @Command
    fun insets(invoke: Invoke) {
        main.post {
            val view = webView
            val insets = view?.let { ViewCompat.getRootWindowInsets(it) }
            val bars = insets?.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val d = activity.resources.displayMetrics.density
            invoke.resolve(JSObject().apply {
                put("top", (bars?.top ?: 0) / d)
                put("bottom", (bars?.bottom ?: 0) / d)
                put("left", (bars?.left ?: 0) / d)
                put("right", (bars?.right ?: 0) / d)
            })
        }
    }

    // ---------- Пульт ТВ ----------

    /// Телевизор или приставка. Многие дешёвые приставки не включают «режим
    /// ТВ», поэтому смотрим ещё на функции Android TV и на отсутствие
    /// сенсорного экрана.
    private fun isTv(): Boolean {
        val ui = activity.getSystemService(UiModeManager::class.java)
        val pm = activity.packageManager
        return ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            pm.hasSystemFeature("android.hardware.type.television") ||
            !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
    }

    /// Плеер под интерфейсом не должен забирать фокус, иначе стрелки пульта
    /// уходят ему, а не кнопкам интерфейса.
    private fun noFocus(v: View) {
        v.isFocusable = false
        v.isFocusableInTouchMode = false
        (v as? ViewGroup)?.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
    }

    private var keyLogged = false
    private val loggedKeys = HashSet<Int>()

    /// Из MainActivity.dispatchKeyEvent: стрелки и «ОК» пульта — в интерфейс
    /// (или в «Обзор», если фокус в нём). `false` — обработать как обычно.
    fun routeKey(event: KeyEvent): Boolean {
        when (event.keyCode) {
            // «Назад» на ТВ: сначала закрыть открытое в интерфейсе (tv.ts/App.tsx,
            // window.__bhBack), в «Обзоре» — страница сайта назад; выйти —
            // только когда закрывать нечего.
            KeyEvent.KEYCODE_BACK -> {
                if (!isTv()) return false
                val ui = webView ?: return false
                if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) {
                    val b = browser
                    val inSite = b != null && b.visibility == View.VISIBLE && b.hasFocus()
                    if (inSite && b!!.canGoBack()) {
                        b.goBack()
                    } else if (inSite) {
                        // Дальше назад некуда — пульт обратно на панель «Обзора».
                        ui.requestFocus()
                        Log.i(TAG, "пульт: из окна сайта — в интерфейс")
                    } else {
                        ui.evaluateJavascript("window.__bhBack ? window.__bhBack() : false") { result ->
                            if (result != "true") activity.finish()
                        }
                    }
                }
                return true
            }
            // Кнопка микрофона на пульте (доходит, только если Google
            // Ассистент выключен) — микрофон пульта в голосовой чат.
            KeyEvent.KEYCODE_PROG_BLUE -> {
                if (!isTv()) return false
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) remoteMicPress()
                return true
            }
        }
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER -> {}
            else -> {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 &&
                    loggedKeys.add(event.keyCode)
                ) {
                    Log.i(TAG, "пульт: другая кнопка ${event.keyCode} (${KeyEvent.keyCodeToString(event.keyCode)})")
                }
                return false
            }
        }
        val ui = webView ?: return false
        val focused = activity.currentFocus
        if (!keyLogged) {
            keyLogged = true
            Log.i(TAG, "пульт: кнопка ${event.keyCode}, фокус у ${focused?.javaClass?.simpleName ?: "никого"}")
        }
        val b = browser
        if (b != null && focused === b && b.visibility == View.VISIBLE) return false
        if (focused !== ui) {
            ui.isFocusable = true
            ui.isFocusableInTouchMode = true
            ui.requestFocus()
        }
        // «ОК» пульта: в поле ввода WebView отдаёт его полю, и до интерфейса
        // оно не доходит. Поэтому нажимаем сами — через tv.ts (window.__bhOk).
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            if (event.action == KeyEvent.ACTION_UP) {
                ui.evaluateJavascript("window.__bhOk ? window.__bhOk() : false", null)
            }
            return true
        }
        return false
    }

    /// Пульт — в окно сайта «Обзора» (если оно открыто).
    @Command
    fun browserFocus(invoke: Invoke) {
        main.post {
            val b = browser
            if (b != null && b.visibility == View.VISIBLE) {
                b.isFocusable = true
                b.isFocusableInTouchMode = true
                b.requestFocus()
                Log.i(TAG, "пульт: в окне сайта")
            }
            invoke.resolve()
        }
    }

    /// Показать экранную клавиатуру для поля, выделенного пультом.
    @Command
    fun showKeyboard(invoke: Invoke) {
        main.post {
            val w = webView
            val imm = activity.getSystemService(InputMethodManager::class.java)
            if (w != null && imm != null) {
                if (!w.hasFocus()) w.requestFocus()
                // Даём WebView подключить поле ввода к системе — и просим клавиатуру.
                main.postDelayed({
                    val shown = imm.showSoftInput(w, 0)
                    Log.i(TAG, "клавиатура: showSoftInput=$shown, активна=${imm.isActive(w)}")
                    if (!shown) {
                        @Suppress("DEPRECATION")
                        imm.toggleSoftInput(InputMethodManager.SHOW_FORCED, 0)
                    }
                }, 100)
            } else {
                Log.w(TAG, "клавиатура: нет WebView или InputMethodManager")
            }
            invoke.resolve()
        }
    }

    // ---------- Ускорение YouTube (dpi.rs) ----------

    /// Новый адрес прокси обхода (null — выключен).
    @Command
    fun setProxy(invoke: Invoke) {
        val args = invoke.parseArgs(ProxyArgs::class.java)
        DpiProxy.set(args.proxy)
        invoke.resolve()
    }

    /// Прямая ссылка на поток ролика (для замера скорости обхода).
    @Command
    fun ytdlStream(invoke: Invoke) {
        val args = invoke.parseArgs(YtdlStreamArgs::class.java)
        Thread {
            try {
                ensureYtdl()
                // Как при открытии видео: если основной клиент YouTube не
                // отдаёт ссылку — запасные.
                var last: Throwable? = null
                for (client in youtubeClients) {
                    try {
                        val request = YoutubeDLRequest(args.url)
                        request.addOption("--no-warnings")
                        request.addOption("--no-playlist")
                        request.addOption("-f", args.format)
                        request.addOption("-g")
                        if (client != null) request.addOption("--extractor-args", client)
                        args.proxy?.let { request.addOption("--proxy", it) }
                        val out = YoutubeDL.getInstance().execute(request).out
                        val link = out.lineSequence().map { it.trim() }.firstOrNull { it.startsWith("http") }
                        if (link != null) {
                            invoke.resolve(JSObject().apply { put("url", link) })
                            return@Thread
                        }
                    } catch (e: Throwable) {
                        Log.w(TAG, "yt-dlp для замера (${client ?: "обычный"}): ${e.message?.lineSequence()?.firstOrNull()}")
                        last = e
                    }
                }
                invoke.reject(last?.message ?: "yt-dlp не отдал ссылку")
            } catch (e: Throwable) {
                Log.w(TAG, "yt-dlp для замера: ${e.message?.lineSequence()?.firstOrNull()}")
                invoke.reject(e.message ?: "yt-dlp не ответил")
            }
        }.start()
    }

    // ---------- СДВГ-режим ----------

    /// Найти ролики (Subway Surfers, мыло, ковры…) и крутить их по очереди.
    @Command
    fun adhdStart(invoke: Invoke) {
        val args = invoke.parseArgs(AdhdArgs::class.java)
        invoke.resolve()
        main.post {
            ensureSide()
            val token = ++sideToken
            loadSideList(args.queries) { if (token == sideToken) nextSide(token) }
        }
    }

    /// СДВГ-режим включён, а в зал ещё не зашли: список роликов и первый
    /// ролик готовим заранее, чтобы в зале он включился сразу.
    @Command
    fun adhdPrepare(invoke: Invoke) {
        val args = invoke.parseArgs(AdhdArgs::class.java)
        invoke.resolve()
        loadSideList(args.queries) { prefetchSide() }
    }

    @Command
    fun adhdStop(invoke: Invoke) {
        invoke.resolve()
        main.post {
            sideToken++
            sideWaiting = false
            sideExo?.release()
            sideExo = null
            sideView?.let { (it.parent as? ViewGroup)?.removeView(it) }
            sideView = null
        }
    }

    @Command
    fun sideRect(invoke: Invoke) {
        val args = invoke.parseArgs(RectArgs::class.java)
        invoke.resolve()
        main.post {
            val v = sideView ?: return@post
            if (!args.visible || args.width <= 0 || args.height <= 0 || inPip) {
                v.visibility = View.GONE
                return@post
            }
            moveTo(v, args.x, args.y, args.width, args.height)
            v.visibility = View.VISIBLE
        }
    }

    private fun ensureSide(): ExoPlayer {
        sideExo?.let { return it }
        val p = ExoPlayer.Builder(activity)
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).build(),
                false
            )
            .build()
        p.volume = 0f
        p.playWhenReady = true
        p.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) nextSide(sideToken)
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.w(TAG, "СДВГ: ролик не открылся", error)
                nextSide(sideToken)
            }
        })
        sideExo = p
        // Ролик обрезаем по краям, чтобы заполнял место без чёрных полос
        // (настройки — в res/layout/side_player.xml).
        val v = android.view.LayoutInflater.from(activity)
            .inflate(R.layout.side_player, null) as PlayerView
        v.clipToOutline = true
        noFocus(v)
        v.player = p
        v.visibility = View.GONE
        val parent = webView?.parent as? ViewGroup
        val lp = FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.START)
        if (parent != null) parent.addView(v, 0, lp) else activity.addContentView(v, lp)
        sideView = v
        return p
    }

    // ---------- СДВГ-режим: всё заранее ----------
    //
    // yt-dlp на ТВ (armv7) запускается по нескольку секунд. Раньше при каждом
    // включении он искал ролики по 8 запросам подряд и потом ещё разбирал
    // ролик — почти минута ожидания. Теперь:
    // - список роликов лежит в файле (adhd-list.json), поиск заново — раз в
    //   3 дня, в фоне и одним запуском yt-dlp на все запросы;
    // - следующий ролик разбирается заранее (пока играет текущий и ещё до
    //   входа в зал) и тоже сохраняется (adhd-next.json): ссылки YouTube живут
    //   несколько часов, берём не старше 3 ч.

    private class SidePrepared(val url: String, val res: Resolved, val json: String, val at: Long)

    /// yt-dlp для СДВГ — отдельно от основного видео, чтобы не задерживать его.
    private val sideWorker = Executors.newSingleThreadExecutor()
    private var sidePrepared: SidePrepared? = null
    private var sidePreparing = false
    /// Плеер ждёт ролик, который ещё разбирается.
    private var sideWaiting = false

    private val sideListFile get() = File(activity.filesDir, "adhd-list.json")
    private val sideNextFile get() = File(activity.filesDir, "adhd-next.json")

    private fun fresh(p: SidePrepared) = System.currentTimeMillis() - p.at < SIDE_LINK_TTL_MS

    /// Список роликов → sideAll/sideQueue, потом `then` (всё на главном потоке).
    private fun loadSideList(queries: Array<String>, then: () -> Unit) {
        main.post {
            if (sideAll.isNotEmpty()) {
                then()
                return@post
            }
            sideWorker.execute {
                val list = sideList(queries)
                val saved = if (sidePrepared == null) readSideNext() else null
                main.post {
                    if (sideAll.isEmpty() && list.isNotEmpty()) {
                        sideAll = list.shuffled()
                        sideQueue.clear()
                        sideQueue.addAll(sideAll)
                    }
                    if (sidePrepared == null && saved != null) sidePrepared = saved
                    then()
                }
            }
        }
    }

    /// Список из файла; нет его — ищем сейчас; устарел — отдаём старый и
    /// обновляем в фоне. (Поток sideWorker.)
    private fun sideList(queries: Array<String>): List<String> {
        var cached = listOf<String>()
        var at = 0L
        try {
            if (sideListFile.exists()) {
                val o = JSONObject(sideListFile.readText())
                at = o.optLong("at")
                val arr = o.optJSONArray("urls") ?: JSONArray()
                cached = (0 until arr.length()).map { arr.getString(it) }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "СДВГ: список не прочитался", e)
        }
        if (cached.isNotEmpty()) {
            if (System.currentTimeMillis() - at > SIDE_LIST_TTL_MS) {
                sideWorker.execute { searchSide(queries) }
            }
            Log.i(TAG, "СДВГ: список из файла, ${cached.size} роликов")
            return cached
        }
        return searchSide(queries)
    }

    /// Поиск роликов по всем запросам и сохранение списка. (Поток sideWorker.)
    private fun searchSide(queries: Array<String>): List<String> {
        ensureYtdl()
        val started = System.currentTimeMillis()
        val ids = LinkedHashSet<String>()
        try {
            // Один запуск yt-dlp на все запросы: на ТВ сам запуск — секунды.
            val request = DpiProxy.apply(YoutubeDLRequest(queries.map { "ytsearch3:$it" }))
            request.addOption("--flat-playlist")
            request.addOption("--no-warnings")
            request.addOption("--ignore-errors")
            request.addOption("--print", "id")
            YoutubeDL.getInstance().execute(request).out.lines().forEach { line ->
                val id = line.trim()
                if (ID_RE.matches(id)) ids.add(id)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "СДВГ: общий поиск не удался, ищу по одному", e)
        }
        if (ids.isEmpty()) {
            for (q in queries) {
                try {
                    val request = DpiProxy.apply(YoutubeDLRequest("ytsearch3:$q"))
                    request.addOption("--flat-playlist")
                    request.addOption("--no-warnings")
                    request.addOption("--print", "id")
                    YoutubeDL.getInstance().execute(request).out.lines().forEach { line ->
                        val id = line.trim()
                        if (ID_RE.matches(id)) ids.add(id)
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "СДВГ: не нашлось «$q»", e)
                }
            }
        }
        val urls = ids.map { "https://www.youtube.com/watch?v=$it" }
        Log.i(TAG, "СДВГ: нашлось ${urls.size} роликов за ${System.currentTimeMillis() - started} мс")
        if (urls.isNotEmpty()) {
            try {
                sideListFile.writeText(
                    JSONObject().put("at", System.currentTimeMillis()).put("urls", JSONArray(urls)).toString()
                )
            } catch (e: Throwable) {
                Log.w(TAG, "СДВГ: список не сохранился", e)
            }
        }
        return urls
    }

    private fun readSideNext(): SidePrepared? = try {
        if (!sideNextFile.exists()) null
        else {
            val o = JSONObject(sideNextFile.readText())
            val json = o.getString("json")
            val res = parseResolved(json)
            val p = res?.let { SidePrepared(o.getString("url"), it, json, o.getLong("at")) }
            if (p != null && fresh(p)) p else null
        }
    } catch (e: Throwable) {
        null
    }

    /// Разобрать следующий ролик заранее (главный поток).
    private fun prefetchSide() {
        if (sidePreparing) return
        sidePrepared?.let { if (fresh(it)) return }
        if (sideQueue.isEmpty()) sideQueue.addAll(sideAll.shuffled())
        val url = sideQueue.removeFirstOrNull() ?: return
        sidePreparing = true
        sideWorker.execute {
            val started = System.currentTimeMillis()
            val json = try {
                ensureYtdl()
                ytdlJson(url, SIDE_FORMAT)
            } catch (e: Throwable) {
                Log.w(TAG, "СДВГ: ролик не разобрался", e)
                null
            }
            val res = json?.let { try { parseResolved(it) } catch (_: Throwable) { null } }
            val p = if (res != null && json != null) SidePrepared(url, res, json, System.currentTimeMillis()) else null
            if (p != null) {
                Log.i(TAG, "СДВГ: следующий ролик готов за ${System.currentTimeMillis() - started} мс")
                try {
                    sideNextFile.writeText(
                        JSONObject().put("url", p.url).put("json", p.json).put("at", p.at).toString()
                    )
                } catch (_: Throwable) {
                }
            }
            main.post {
                sidePreparing = false
                if (p != null) sidePrepared = p
                if (sideWaiting) {
                    sideWaiting = false
                    // Не разобрался — следующий, но не чаще раза в 2 секунды.
                    if (p != null) nextSide(sideToken)
                    else main.postDelayed({ nextSide(sideToken) }, 2000)
                }
            }
        }
    }

    /// Следующий ролик (без звука): готовый заранее — сразу, иначе ждём разбора.
    private fun nextSide(token: Int) {
        if (token != sideToken) return
        val p = sideExo ?: return
        val ready = sidePrepared?.takeIf { fresh(it) }
        sidePrepared = null
        if (ready == null) {
            sideWaiting = true
            prefetchSide()
            return
        }
        sideNextFile.delete()
        // Только картинка: звук ролика не нужен.
        p.setMediaSource(source(ready.res.streams.first()))
        p.prepare()
        // Пока играет этот — готовим следующий.
        prefetchSide()
    }

    /// Телевизор ли это (интерфейс включает управление пультом).
    @Command
    fun info(invoke: Invoke) {
        invoke.resolve(JSObject().apply { put("tv", isTv()) })
    }

    // ---------- Обновление ----------

    /// Скачать APK новой версии и открыть установку. Отвечаем, когда файл
    /// скачан и окно установки открыто (или с ошибкой).
    @Command
    fun installApk(invoke: Invoke) {
        val args = invoke.parseArgs(InstallArgs::class.java)
        Thread {
            try {
                val file = File(activity.cacheDir, "BrotherHub-update.apk")
                var link = URL(args.url)
                // GitHub отдаёт файл через перенаправления на другой сервер.
                var conn: HttpURLConnection
                var hops = 0
                while (true) {
                    conn = link.openConnection() as HttpURLConnection
                    conn.instanceFollowRedirects = false
                    conn.connectTimeout = 20000
                    conn.readTimeout = 30000
                    val code = conn.responseCode
                    if (code in 300..399 && hops < 8) {
                        link = URL(link, conn.getHeaderField("Location"))
                        conn.disconnect()
                        hops++
                        continue
                    }
                    if (code != 200) throw IllegalStateException("сервер ответил $code")
                    break
                }
                conn.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
                val uri = FileProvider.getUriForFile(
                    activity, "${activity.packageName}.fileprovider", file
                )
                val intent = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                main.post {
                    try {
                        activity.startActivity(intent)
                        invoke.resolve()
                    } catch (e: Throwable) {
                        invoke.reject("Не открылась установка: ${e.message}")
                    }
                }
            } catch (e: Throwable) {
                Log.w(TAG, "обновление не скачалось", e)
                invoke.reject("Не удалось скачать обновление: ${e.message}")
            }
        }.start()
    }

    // ---------- «Обзор» ----------

    @Command
    fun browserOpen(invoke: Invoke) {
        val args = invoke.parseArgs(BrowserOpenArgs::class.java)
        main.post {
            val b = ensureBrowser(args.script)
            b.loadUrl(args.url)
            args.rect?.let { placeBrowser(b, it) }
            b.visibility = View.VISIBLE
            invoke.resolve()
        }
    }

    @Command
    fun browserPlace(invoke: Invoke) {
        val args = invoke.parseArgs(BrowserPlaceArgs::class.java)
        invoke.resolve()
        main.post {
            val b = browser ?: return@post
            val r = args.rect
            if (r == null) b.visibility = View.GONE
            else {
                placeBrowser(b, r)
                b.visibility = View.VISIBLE
            }
        }
    }

    @Command
    fun browserUrl(invoke: Invoke) {
        main.post { invoke.resolve(JSObject().apply { put("url", browser?.url) }) }
    }

    @Command
    fun browserBack(invoke: Invoke) {
        invoke.resolve()
        main.post { browser?.let { if (it.canGoBack()) it.goBack() } }
    }

    /// Спрятать, не закрывая: в следующий раз — та же страница.
    @Command
    fun browserHide(invoke: Invoke) {
        invoke.resolve()
        main.post {
            browser?.let {
                it.evaluateJavascript(
                    "document.querySelectorAll('video,audio').forEach(function(m){try{m.pause()}catch(e){}})",
                    null
                )
                it.visibility = View.GONE
            }
        }
    }

    @Command
    fun browserShow(invoke: Invoke) {
        val args = invoke.parseArgs(BrowserPlaceArgs::class.java)
        main.post {
            val b = browser
            if (b == null) {
                invoke.resolve(JSObject().apply { put("shown", false) })
                return@post
            }
            args.rect?.let { placeBrowser(b, it) }
            b.visibility = View.VISIBLE
            invoke.resolve(JSObject().apply { put("shown", true) })
        }
    }

    @Command
    fun browserClose(invoke: Invoke) {
        invoke.resolve()
        main.post {
            browser?.let {
                (it.parent as? ViewGroup)?.removeView(it)
                it.destroy()
            }
            browser = null
        }
    }

    private fun ensureBrowser(script: String?): WebView {
        browser?.let { return it }
        browserScript = script
        val b = WebView(activity)
        b.settings.javaScriptEnabled = true
        b.settings.domStorageEnabled = true
        b.settings.mediaPlaybackRequiresUserGesture = true
        // Ссылки «в новом окне» открываются здесь же.
        b.settings.setSupportMultipleWindows(false)
        if (isTv()) {
            // На ТВ сайты по умолчанию открываются в мобильном виде (WebView
            // представляется телефоном) — просим обычную версию для компьютера.
            b.settings.userAgentString =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
            b.settings.useWideViewPort = true
            b.settings.loadWithOverviewMode = true
        }
        b.setBackgroundColor(Color.BLACK)
        val docStart = script != null &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (docStart) {
            WebViewCompat.addDocumentStartJavaScript(b, script!!, setOf("*"))
        }
        b.webViewClient = object : WebViewClient() {
            // Только https — приложения и странные схемы не открываем.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.scheme != "https"

            override fun onPageFinished(view: WebView, url: String?) {
                if (!docStart) browserScript?.let { view.evaluateJavascript(it, null) }
            }
        }
        b.webChromeClient = WebChromeClient()
        b.visibility = View.GONE
        // Поверх интерфейса — в тот же контейнер, последним.
        val parent = webView?.parent as? ViewGroup
        val lp = FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.START)
        if (parent != null) parent.addView(b, lp) else activity.addContentView(b, lp)
        browser = b
        return b
    }

    private fun placeBrowser(b: WebView, r: Area) {
        moveTo(b, r.x, r.y, r.width, r.height)
    }

    /// Поставить окно (видео, ролик, сайт) в прямоугольник интерфейса.
    /// Положение — сдвигом (дёшево, можно каждый кадр при прокрутке),
    /// размер — только если он поменялся: перерасчёт раскладки дорогой.
    private fun moveTo(v: View, x: Int, y: Int, width: Int, height: Int) {
        val w = width.coerceAtLeast(1)
        val h = height.coerceAtLeast(1)
        val lp = v.layoutParams as? FrameLayout.LayoutParams
        if (lp == null || lp.width != w || lp.height != h || lp.leftMargin != 0 || lp.topMargin != 0) {
            val next = lp ?: FrameLayout.LayoutParams(w, h)
            next.width = w
            next.height = h
            next.gravity = Gravity.TOP or Gravity.START
            next.leftMargin = 0
            next.topMargin = 0
            v.layoutParams = next
        }
        v.translationX = ((webView?.left ?: 0) + x).toFloat()
        v.translationY = ((webView?.top ?: 0) + y).toFloat()
    }

    // ---------- Фон и «картинка в картинке» ----------

    /// Пока ты в зале (`room`), приложение работает и свёрнутым:
    /// служба с уведомлением (PlaybackService). `room = null` — вышел.
    @Command
    fun keepAlive(invoke: Invoke) {
        val args = invoke.parseArgs(KeepAliveArgs::class.java)
        invoke.resolve()
        main.post {
            voiceOn = args.room != null && args.mic
            applyAudioRoute()
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

    /// Пока идёт голосовой чат, Android переводит звук в «режим звонка», и
    /// обычный звук фильма в нём сильно приглушается. Поэтому фильм на это
    /// время играет по тому же каналу, что и голос: громко, и эхоподавление
    /// не пускает фильм в твой микрофон. Без голоса — обычный звук.
    private fun applyAudioRoute() {
        val p = exo ?: return
        val attrs = if (voiceOn && !isTv()) {
            AudioAttributes.Builder()
                .setUsage(C.USAGE_VOICE_COMMUNICATION)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build()
        } else {
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build()
        }
        p.setAudioAttributes(attrs, false)
    }

    /// ТВ: WebRTC в WebView включает «режим звонка», а звонок на ТВ идёт только
    /// в его динамики — с Bluetooth-наушниками звука нет вовсе (динамики
    /// выключены), и фильм, и голоса пропадают. Ни трубки, ни гарнитуры у ТВ
    /// нет, так что режим звонка ему не нужен — держим обычный, тогда звук
    /// идёт туда же, куда весь звук ТВ.
    private fun keepNormalAudioMode() {
        val am = activity.getSystemService(android.media.AudioManager::class.java) ?: return
        fun reset() {
            if (am.mode != android.media.AudioManager.MODE_NORMAL) {
                am.mode = android.media.AudioManager.MODE_NORMAL
                Log.i(TAG, "звук: режим звонка на ТВ выключен")
            }
        }
        if (Build.VERSION.SDK_INT >= 31) {
            am.addOnModeChangedListener({ main.post(it) }) { reset() }
        } else {
            main.postDelayed(object : Runnable {
                override fun run() { reset(); main.postDelayed(this, 2000) }
            }, 2000)
        }
        reset()
    }

    // ---------- Микрофон пульта (ТВ) ----------
    //
    // Встроенного микрофона у ТВ нет, а пульт отдаёт звук только записи,
    // открытой ПОСЛЕ нажатия его кнопки, и только на 16 кГц (как голосовой
    // поиск). WebView пишет на 48 кГц и получает нули. Поэтому пишем сами:
    // AudioRecord 16 кГц, кусками по 40 мс → в интерфейс (remoteMic.ts), а он
    // отправляет это друзьям вместо обычного микрофона. Пульт передаёт звук
    // ~15 с после нажатия; замолчал или нажали ещё раз — выключаемся.

    @Volatile
    private var remoteOn = false
    /// Номер записи: остановка от старой записи новую не трогает.
    @Volatile
    private var remoteSession = 0
    private var remoteThread: Thread? = null

    private fun remoteMicPress() {
        if (remoteOn) {
            stopRemoteMic("нажали ещё раз")
            return
        }
        val ui = webView ?: return
        // Интерфейс решает, можно ли сейчас говорить (подключён ли голос).
        ui.evaluateJavascript("window.__bhRemoteMicPress ? window.__bhRemoteMicPress() : false") { r ->
            if (r == "true") startRemoteMic()
            else Log.i(TAG, "микрофон пульта: голос не подключён")
        }
    }

    private fun startRemoteMic() {
        if (remoteOn) return
        if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            activity.requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 42)
            remoteMicState(false, "Разреши приложению микрофон и нажми кнопку на пульте ещё раз")
            return
        }
        // Прошлая запись ещё закрывается — дождёмся (не дольше 200 мс).
        remoteThread?.join(200)
        val rate = 16000
        val chunk = rate / 25 // 40 мс
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION, rate,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min, chunk * 2 * 4),
            )
        } catch (e: Throwable) {
            Log.w(TAG, "микрофон пульта: запись не создалась", e)
            remoteMicState(false, "Микрофон пульта не открылся")
            return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            Log.w(TAG, "микрофон пульта: запись не готова")
            remoteMicState(false, "Микрофон пульта не открылся")
            return
        }
        try {
            rec.startRecording()
        } catch (e: Throwable) {
            rec.release()
            Log.w(TAG, "микрофон пульта: запись не началась", e)
            remoteMicState(false, "Микрофон пульта не открылся")
            return
        }
        val session = ++remoteSession
        remoteOn = true
        remoteMicState(true, null)
        Log.i(TAG, "микрофон пульта: пишу 16 кГц")
        val t = Thread({
            val buf = ShortArray(chunk)
            val bytes = ByteArray(chunk * 2)
            var heard = false
            var silentMs = 0
            var peakMax = 0
            while (remoteOn && remoteSession == session) {
                val n = rec.read(buf, 0, chunk)
                if (n < 0) {
                    Log.w(TAG, "микрофон пульта: ошибка чтения $n")
                    main.post { if (remoteSession == session) stopRemoteMic("ошибка записи", "Микрофон пульта отключился") }
                    break
                }
                if (n == 0) continue
                var peak = 0
                for (i in 0 until n) {
                    val v = buf[i].toInt()
                    val a = if (v < 0) -v else v
                    if (a > peak) peak = a
                    bytes[2 * i] = (v and 0xff).toByte()
                    bytes[2 * i + 1] = ((v shr 8) and 0xff).toByte()
                }
                if (peak > peakMax) peakMax = peak
                if (peak > 0) {
                    heard = true
                    silentMs = 0
                } else {
                    silentMs += n * 1000 / rate
                }
                // Пульт замолчал (ровные нули). До первого звука ждём дольше.
                if (silentMs >= (if (heard) 1500 else 3000)) {
                    val wasHeard = heard
                    main.post {
                        if (remoteSession != session) return@post
                        if (wasHeard) stopRemoteMic("пульт замолчал")
                        else stopRemoteMic(
                            "от пульта нет звука",
                            "От пульта не пришёл звук. Если включён Google Ассистент, он забирает микрофон пульта",
                        )
                    }
                    break
                }
                val b64 = Base64.encodeToString(bytes, 0, n * 2, Base64.NO_WRAP)
                main.post {
                    if (remoteSession == session && remoteOn) {
                        webView?.evaluateJavascript("window.__bhRemotePcm && window.__bhRemotePcm('$b64')", null)
                    }
                }
            }
            try {
                rec.stop()
            } catch (_: Throwable) {
            }
            rec.release()
            Log.i(TAG, "микрофон пульта: запись закрыта, наибольший пик $peakMax")
        }, "remote-mic")
        remoteThread = t
        t.start()
    }

    private fun stopRemoteMic(reason: String, error: String? = null) {
        if (!remoteOn) return
        remoteOn = false
        Log.i(TAG, "микрофон пульта: выключен ($reason)")
        remoteMicState(false, error)
    }

    private fun remoteMicState(on: Boolean, error: String?) {
        val err = if (error == null) "null" else JSONObject.quote(error)
        webView?.evaluateJavascript("window.__bhRemoteMic && window.__bhRemoteMic($on, $err)", null)
    }

    /// Интерфейс выключает микрофон пульта (кнопка микрофона, вышел из голоса).
    @Command
    fun remoteMic(invoke: Invoke) {
        val args = invoke.parseArgs(RemoteMicArgs::class.java)
        invoke.resolve()
        main.post { if (!args.on) stopRemoteMic("из интерфейса") }
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
            sideView?.visibility = View.GONE
            v.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            v.translationX = 0f
            v.translationY = 0f
            v.visibility = View.VISIBLE
        } else {
            webView?.visibility = View.VISIBLE
            lastRect?.let { place(it) }
        }
    }

    /// Цвет «зала» под прозрачным интерфейсом — по теме оформления.
    @Command
    fun background(invoke: Invoke) {
        val args = invoke.parseArgs(BackgroundArgs::class.java)
        invoke.resolve()
        main.post {
            try {
                activity.window.setBackgroundDrawable(ColorDrawable(Color.parseColor(args.color)))
            } catch (e: Throwable) {
                Log.w(TAG, "странный цвет фона: ${args.color}", e)
            }
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
        // Включили другое видео — старое сразу останавливаем, а прежний
        // yt-dlp прерываем: раньше новое ждало в очереди, пока старое
        // разберётся (через обход — до нескольких минут).
        loadProcess?.let { old ->
            try {
                YoutubeDL.getInstance().destroyProcessById(old)
            } catch (_: Throwable) {
            }
        }
        val pid = "load-$token"
        loadProcess = pid
        exo?.let {
            it.stop()
            it.clearMediaItems()
        }
        Thread {
            val result = try {
                resolve(url, fmt, pid) { token == loadToken }
            } catch (e: Throwable) {
                if (token == loadToken) Log.w(TAG, "yt-dlp не разобрал $url", e)
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
        }.start()
    }

    private data class Stream(val url: String, val protocol: String?, val headers: Map<String, String>)

    private data class Resolved(val streams: List<Stream>, val title: String?, val json: String)

    /// Разные «клиенты» YouTube: если основной не отдаёт видео («This video is
    /// not available» — YouTube так режет часть запросов с телефонов),
    /// пробуем притвориться телевизором, мобильным сайтом и т.д.
    private val youtubeClients = listOf(
        null,
        "youtube:player_client=tv,mweb",
        "youtube:player_client=android_vr,web_safari",
        "youtube:player_client=ios,web_embedded",
    )

    private fun ytdlJson(
        url: String,
        fmt: String,
        pid: String? = null,
        alive: () -> Boolean = { true },
    ): String {
        val host = Uri.parse(url).host?.lowercase() ?: ""
        val isYoutube = host.endsWith("youtube.com") || host == "youtu.be"
        val attempts = if (isYoutube) youtubeClients else listOf(null)
        var last: Throwable? = null
        for (client in attempts) {
            // Уже включили другое видео — запасные клиенты не перебираем.
            if (!alive()) throw IllegalStateException("видео сменили")
            try {
                val request = DpiProxy.apply(YoutubeDLRequest(url))
                request.addOption("--no-warnings")
                request.addOption("--no-playlist")
                request.addOption("-J")
                request.addOption("-f", fmt)
                if (client != null) request.addOption("--extractor-args", client)
                return try {
                    YoutubeDL.getInstance().execute(request, pid).out
                } catch (e: Throwable) {
                    // Нужного качества нет — берём что есть.
                    if (e.message?.contains("Requested format is not available") != true) throw e
                    val any = DpiProxy.apply(YoutubeDLRequest(url))
                    any.addOption("--no-warnings")
                    any.addOption("--no-playlist")
                    any.addOption("-J")
                    if (client != null) any.addOption("--extractor-args", client)
                    YoutubeDL.getInstance().execute(any, pid).out
                }
            } catch (e: Throwable) {
                Log.w(TAG, "yt-dlp (${client ?: "обычный"}): ${e.message?.lineSequence()?.firstOrNull()}")
                last = e
            }
        }
        throw last ?: IllegalStateException("yt-dlp не ответил")
    }

    private fun resolve(
        url: String,
        fmt: String,
        pid: String? = null,
        alive: () -> Boolean = { true },
    ): Resolved? {
        ensureYtdl()
        return parseResolved(ytdlJson(url, fmt, pid, alive))
    }

    /// Ответ yt-dlp (-J) → ссылки на потоки.
    private fun parseResolved(json: String): Resolved? {
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

    private val ytdlLock = Any()

    /// Запустить yt-dlp один раз (из любого потока).
    private fun ensureYtdl() {
        if (ytdlReady) return
        synchronized(ytdlLock) {
            if (ytdlReady) return
            YoutubeDL.getInstance().init(activity.applicationContext)
            ytdlReady = true
        }
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
        exo = p
        applyAudioRoute()
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
        noFocus(v)
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
        moveTo(v, r.x, r.y, r.width, r.height)
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
            val status = method.invoke(ydl, context, channel)
            val version = ydl.javaClass.methods
                .firstOrNull { it.name == "version" && it.parameterTypes.size == 1 }
                ?.invoke(ydl, context)
            Log.i(TAG, "yt-dlp: обновление — $status, версия $version")
        } catch (e: Throwable) {
            Log.w(TAG, "yt-dlp не обновился", e)
        }
    }

    companion object {
        /// Для MainActivity: «картинка в картинке» приходит туда.
        var instance: PlayerPlugin? = null
    }
}
