//! BrotherHub: общая часть для Windows и Android.
//!
//! На компьютере видео показывает mpv (player.rs), на телефоне — ExoPlayer
//! из Kotlin-части приложения (player_android.rs + PlayerPlugin.kt).
//! Всё, что бывает только на компьютере (окна поверх видео, трей,
//! глобальные клавиши, обновление exe), собирается только там.

mod logs;
mod net;
#[cfg_attr(target_os = "android", path = "player_android.rs")]
mod player;
mod playlist;
mod prefetch;
mod session;
mod sites;
mod titles;
#[cfg_attr(mobile, path = "tools_mobile.rs")]
mod tools;
#[cfg_attr(mobile, path = "video_mobile.rs")]
mod video;

#[cfg(desktop)]
mod adhd;
#[cfg_attr(mobile, path = "browser_mobile.rs")]
mod browser;
#[cfg(desktop)]
mod certs;
#[cfg(desktop)]
mod deeplink;
#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
mod overlay;
#[cfg(desktop)]
mod ptt;
#[cfg(desktop)]
mod reactions;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod update;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    {
        logs::init();
        update::cleanup();
    }

    // Телефон: шифрование rustls — выбираем ему движок ring явно.
    #[cfg(mobile)]
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        // Первым: второй запуск (в том числе по ссылке-приглашению)
        // отдаёт ссылку уже открытому приложению и закрывается.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_app(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(deeplink::Pending::default());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(player::plugin());

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(net::Connection::default())
        .manage(video::VideoHost::default())
        .setup(|app| {
            #[cfg(desktop)]
            desktop_setup(app);
            #[cfg(mobile)]
            {
                // На телефоне папка данных известна только здесь.
                if let Ok(dir) = app.path().app_local_data_dir() {
                    tools::set_data_dir(dir);
                }
                logs::init();
            }
            let session = session::Session::start(app.handle().clone());
            app.manage(session);
            Ok(())
        });

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        net::connect,
        net::disconnect,
        net::connection_token,
        net::send,
        session::open_file,
        session::open_url,
        session::player_status,
        session::set_chat_overlay,
        session::player_info,
        session::player_control,
        session::close_media,
        session::set_quality,
        session::player_cursor,
        session::subtitles_share,
        session::subtitles_clear,
        video::set_video_rect,
        video::set_side_rect,
        adhd::adhd_start,
        adhd::adhd_stop,
        video::watch_cursor,
        overlay::overlay_place,
        overlay::overlay_interactive,
        overlay::overlay_close,
        ptt::ptt_set_key,
        ptt::ptt_capture,
        ptt::mute_set_key,
        tools::player_tools,
        tools::player_setup,
        logs::open_logs,
        logs::ui_log,
        browser::browser_open,
        browser::browser_place,
        browser::browser_url,
        browser::browser_back,
        browser::browser_close,
        browser::browser_hide,
        browser::browser_show,
        prefetch::prefetch_media,
        update::update_check,
        update::update_install,
        deeplink::deep_link_take,
        reactions::reactions_place,
        titles::media_title,
        playlist::playlist_entries,
        tray::tray_close_to_tray,
        tray::tray_hide
    ]);

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        net::connect,
        net::disconnect,
        net::connection_token,
        net::send,
        session::open_file,
        session::open_url,
        session::player_status,
        session::set_chat_overlay,
        session::player_info,
        session::player_control,
        session::close_media,
        session::set_quality,
        session::player_cursor,
        session::subtitles_share,
        session::subtitles_clear,
        video::set_video_rect,
        video::set_side_rect,
        video::watch_cursor,
        tools::player_tools,
        tools::player_setup,
        logs::ui_log,
        prefetch::prefetch_media,
        titles::media_title,
        playlist::playlist_entries,
        mobile::deep_link_take,
        mobile::update_check,
        mobile::update_install,
        mobile::tray_close_to_tray,
        mobile::ptt_set_key,
        mobile::mute_set_key,
        mobile::overlay_close,
        mobile::reactions_place,
        mobile::adhd_stop,
        mobile::mobile_fullscreen
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("не удалось запустить BrotherHub");
}

/// Окна, трей, ссылки-приглашения — только на компьютере.
#[cfg(desktop)]
fn desktop_setup(app: &mut tauri::App) {
    // Окно для встроенного видео (setup выполняется в главном потоке).
    if let Some(window) = app.get_webview_window("main") {
        app.manage(overlay::MainWindow(window.clone()));
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if tray::close_to_tray() {
                    tray::hide_app(&handle);
                } else {
                    // Сначала выходим из комнаты, потом закрываемся.
                    net::quit(&handle);
                }
                return;
            }
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                overlay::follow(&handle);
                browser::follow(&handle);
                reactions::follow(&handle);
            }
        });
        if let Err(e) = video::create(&window, &app.state::<video::VideoHost>()) {
            logs::warn(format!("видео будет в отдельном окне: {e}"));
        }
    }
    deeplink::setup(app);
    if let Err(e) = tray::setup(app) {
        logs::warn(format!("значок в трее не появился: {e}"));
    }
    player::update_bundled_ytdlp();
}
