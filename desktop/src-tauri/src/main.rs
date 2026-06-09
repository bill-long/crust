// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // When re-launched as the global-hotkey sidecar, run ONLY the keyboard hook
    // loop (no Tauri, no window) and never fall through to the normal app. This
    // must be the very first thing in `main`, before any Tauri/plugin init.
    if std::env::args_os().any(|a| a == "--mic-hotkey-helper") {
        crust_lib::run_helper();
    }
    crust_lib::run()
}
