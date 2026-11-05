fn main() {
    // Пересобирать, когда меняется иконка: иначе в exe остаётся старая
    // (Windows берёт значок для панели задач из ресурсов exe).
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
