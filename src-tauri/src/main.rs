#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--mcp") {
        zugit_lib::run_mcp();
        return;
    }
    zugit_lib::run();
}
