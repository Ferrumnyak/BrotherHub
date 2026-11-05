// В релизной сборке не открывать лишнее консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod net;
mod player;
mod ptt;
mod session;
mod video;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(net::Connection::default())
        .manage(video::VideoHost::default())
        .setup(|app| {
            // Окно для встроенного видео (setup выполняется в главном потоке).
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = video::create(&window, &app.state::<video::VideoHost>()) {
                    eprintln!("видео будет в отдельном окне: {e}");
                }
            }
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
            video::set_video_rect,
            ptt::ptt_set_key,
            ptt::ptt_capture
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить BrotherWatch");
}
