// Crust desktop shell (Phase 2): two-window call overlay.
//
// The main window loads the Crust app. On request (a Tauri command invoked by
// the in-app call pop-out button, or a global hotkey) it spawns a SECOND
// always-on-top, transparent, chromeless window pointing at the app's
// `/overlay` route. Both windows share an origin, so the app bridges live call
// state between them over a BroadcastChannel (no Rust involvement in the data).
//
// Global hotkeys:
//   Ctrl+Shift+O  toggle overlay click-through (mouse passes to the game)
//   Ctrl+Shift+L  close the overlay window
//   Ctrl+Shift+Q  quit

use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::ShortcutState;

mod mic_hotkey;
pub use mic_hotkey::run_helper;

const OVERLAY_LABEL: &str = "overlay";

#[derive(Default)]
struct OverlayState {
    click_through: Mutex<bool>,
}

/// The overlay URL: the main window's current origin + `/overlay`. Using the
/// main window's origin keeps the overlay same-origin (so the BroadcastChannel
/// bridge works) and, because that origin matches the dev/app URL Tauri trusts,
/// the overlay still receives Tauri's IPC + `data-tauri-drag-region` injection.
/// An App URL can't be used here: in dev it resolves to the production asset
/// protocol (tauri://localhost), which isn't served, yielding a blank window.
fn overlay_url(app: &AppHandle) -> Result<WebviewUrl, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let mut url = main.url().map_err(|e| e.to_string())?;
    url.set_path("/overlay");
    url.set_query(None);
    url.set_fragment(None);
    Ok(WebviewUrl::External(url))
}

fn build_overlay(app: &AppHandle) -> Result<(), String> {
    let url = overlay_url(app)?;
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, url)
        .title("Crust — Voice")
        .inner_size(320.0, 420.0)
        .min_inner_size(240.0, 200.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    // This command is `async`, so Tauri runs it OFF the main thread. That lets
    // the blocking `WebviewWindowBuilder::build()` marshal window creation to the
    // main event loop without deadlocking — a synchronous command would run ON
    // the main thread and hang, since build() waits on that same thread.
    build_overlay(&app)?;
    // A freshly-opened overlay starts interactive (not click-through).
    *app.state::<OverlayState>().click_through.lock().unwrap() = false;
    Ok(())
}

#[tauri::command]
fn close_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn overlay_is_open(app: AppHandle) -> bool {
    app.get_webview_window(OVERLAY_LABEL).is_some()
}

fn apply_click_through(app: &AppHandle, on: bool) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.set_ignore_cursor_events(on);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(OverlayState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let state = app.state::<OverlayState>();
                    let printable = shortcut.to_string().to_lowercase();
                    if printable.contains("keyo") {
                        let mut ct = state.click_through.lock().unwrap();
                        *ct = !*ct;
                        apply_click_through(app, *ct);
                    } else if printable.contains("keyl") {
                        if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
                            let _ = win.close();
                        }
                    } else if printable.contains("keyq") {
                        app.exit(0);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            open_overlay,
            close_overlay,
            overlay_is_open,
            mic_hotkey::set_mic_hotkey
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let gs = app.global_shortcut();
            // Best-effort: a shortcut already held by another process must not
            // abort app startup. Log and continue so the app still launches.
            for accel in ["ctrl+shift+o", "ctrl+shift+l", "ctrl+shift+q"] {
                if let Err(e) = gs.register(accel) {
                    eprintln!("[crust] failed to register {accel}: {e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
