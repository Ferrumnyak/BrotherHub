// В релизной сборке не открывать лишнее консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod certs;
mod deeplink;
mod logs;
mod net;
mod overlay;
mod player;
mod ptt;
mod reactions;
mod session;
mod sites;
mod titles;
mod tools;
mod update;
mod video;

use tauri::Manager;

fn main() {
    logs::init();
    update::cleanup();
    tauri::Builder::default()
        // Первым: второй запуск (в том числе по ссылке-приглашению)
        // отдаёт ссылку уже открытому приложению и закрывается.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            deeplink::show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(net::Connection::default())
        .manage(video::VideoHost::default())
        .manage(deeplink::Pending::default())
        .setup(|app| {
            // Окно для встроенного видео (setup выполняется в главном потоке).
            if let Some(window) = app.get_webview_window("main") {
                app.manage(overlay::MainWindow(window.clone()));
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
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
            player::update_bundled_ytdlp();
            let session = session::Session::start(app.handle().clone());
            app.manage(session);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            net::connect,
            net::disconnect,
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
            update::update_check,
            update::update_install,
            deeplink::deep_link_take,
            reactions::reactions_place,
            titles::media_title
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить BrotherHub");
}
