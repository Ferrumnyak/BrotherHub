// В релизной сборке не открывать лишнее консольное окно на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    brotherwatch_lib::run();
}
