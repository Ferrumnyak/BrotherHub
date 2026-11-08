use std::{env, path::PathBuf, process::Command};

fn main() {
    // Пересобирать, когда меняется иконка: иначе в exe остаётся старая
    // (Windows берёт значок для панели задач из ресурсов exe).
    println!("cargo:rerun-if-changed=icons");
    build_ciadpi();
    tauri_build::build()
}

/// Телефон и ТВ: собрать ByeDPI (`ciadpi`, ускорение YouTube, см. dpi.rs)
/// из исходников в `byedpi/` как исполняемый файл и положить его к
/// нативным библиотекам APK под именем `libciadpi.so`: Android распаковывает
/// их в папку, откуда файлы можно запускать. Исходники кладёт
/// `scripts/fetch-byedpi.ps1`.
fn build_ciadpi() {
    println!("cargo:rerun-if-changed=byedpi");
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("apple-darwin") {
        build_ciadpi_macos();
        return;
    }
    if !target.contains("android") {
        return;
    }
    let abi = match target.split('-').next().unwrap_or("") {
        "aarch64" => "arm64-v8a",
        "armv7" => "armeabi-v7a",
        "i686" => "x86",
        "x86_64" => "x86_64",
        other => {
            println!("cargo:warning=ByeDPI: неизвестная архитектура {other}, собираю без него");
            return;
        }
    };
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("byedpi");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&src)
        .map(|dir| {
            dir.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "c"))
                .filter(|p| !p.file_name().is_some_and(|n| n == "win_service.c"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        println!(
            "cargo:warning=Нет исходников ByeDPI в app/src-tauri/byedpi — APK соберётся без ускорения YouTube (запусти scripts/fetch-byedpi.ps1)"
        );
        return;
    }

    let out_dir = manifest.join("gen/android/app/src/main/jniLibs").join(abi);
    std::fs::create_dir_all(&out_dir).expect("не удалось создать папку jniLibs");
    let out = out_dir.join("libciadpi.so");

    // Компилятор NDK для этой архитектуры (его же берёт cc для Rust-зависимостей).
    let compiler = cc::Build::new().opt_level(2).get_compiler();
    let mut cmd: Command = compiler.to_command();
    cmd.args(["-std=gnu99", "-D_DEFAULT_SOURCE", "-D_GNU_SOURCE", "-O2", "-w", "-fPIE", "-pie", "-s"])
        .arg(format!("-I{}", src.display()))
        .args(&files)
        .arg("-o")
        .arg(&out);
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("не удалось запустить компилятор для ByeDPI: {e}"));
    assert!(status.success(), "ByeDPI не собрался под {target} ({status})");
}

/// macOS: собрать `ciadpi` сразу для Apple Silicon и Intel (один файл на
/// обе архитектуры — так он подходит и к универсальной сборке приложения) в
/// `byedpi-build/ciadpi`; оттуда tauri.macos.conf.json кладёт его в
/// `BrotherHub.app/Contents/Resources`. Не собрался — приложение всё равно
/// соберётся, но без ускорения YouTube (пустой файл, см. dpi.rs).
fn build_ciadpi_macos() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("byedpi");
    let out_dir = manifest.join("byedpi-build");
    std::fs::create_dir_all(&out_dir).expect("не удалось создать папку byedpi-build");
    let out = out_dir.join("ciadpi");

    let mut files: Vec<PathBuf> = std::fs::read_dir(&src)
        .map(|dir| {
            dir.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "c"))
                .filter(|p| !p.file_name().is_some_and(|n| n == "win_service.c"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();

    let built = !files.is_empty()
        && Command::new("xcrun")
            .args(["clang", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0"])
            .args(["-std=gnu99", "-O2", "-w"])
            .arg(format!("-I{}", src.display()))
            .args(&files)
            .arg("-o")
            .arg(&out)
            .status()
            .is_ok_and(|s| s.success());
    if !built {
        println!(
            "cargo:warning=ByeDPI не собрался под macOS — приложение будет без ускорения YouTube"
        );
        std::fs::write(&out, b"").expect("не удалось записать byedpi-build/ciadpi");
    }
}
