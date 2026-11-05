// В релизной сборке не открывать лишнее консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod net;
mod player;
mod session;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(net::Connection::default())
        .setup(|app| {
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
            session::player_status
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить BrotherWatch");
}
