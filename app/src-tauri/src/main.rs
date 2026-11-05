// В релизной сборке не открывать лишнее консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod certs;
mod logs;
mod net;
mod overlay;
mod player;
mod ptt;
mod session;
mod sites;
mod tools;
mod video;

use tauri::Manager;

fn main() {
    logs::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(net::Connection::default())
        .manage(video::VideoHost::default())
        .setup(|app| {
            // Окно для встроенного видео (setup выполняется в главном потоке).
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = video::create(&window, &app.state::<video::VideoHost>()) {
                    logs::warn(format!("видео будет в отдельном окне: {e}"));
                }
            }
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
            video::set_video_rect,
            video::watch_cursor,
            overlay::overlay_place,
            overlay::overlay_interactive,
            overlay::overlay_close,
            ptt::ptt_set_key,
            ptt::ptt_capture,
            tools::player_tools,
            tools::player_setup,
            logs::open_logs
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить BrotherWatch");
}
