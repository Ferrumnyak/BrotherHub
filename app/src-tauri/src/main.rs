// В релизной сборке не открывать лишнее консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod net;

fn main() {
    tauri::Builder::default()
        .manage(net::Connection::default())
        .invoke_handler(tauri::generate_handler![
            net::connect,
            net::disconnect,
            net::send
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить BrotherWatch");
}
