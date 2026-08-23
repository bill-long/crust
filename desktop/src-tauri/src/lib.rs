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
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_updater::{Update, UpdaterExt};

mod mic_hotkey;
pub use mic_hotkey::run_helper;

const OVERLAY_LABEL: &str = "overlay";

/// Attached to every Crust webview, to run before the page's own scripts
/// whatever served the page. It evicts the precaching service worker that
/// builds before the fix for #481 registered on this origin: WebView2 never
/// completes an update check for a worker on the asset-protocol origin, so that
/// worker kept serving its own build's app shell on every launch - against an
/// exe whose hashed assets had moved on - and the shell it served was the one
/// that did not know to unregister it. An initialization script is the one hook
/// that reaches such a page from outside. The script holds the detection rule;
/// src/lib/nativeServiceWorker.ts describes the worker the current build
/// registers instead.
const EVICT_LEGACY_SW_SCRIPT: &str = include_str!("evict_legacy_sw.js");

/// Emitted once an update has been downloaded and is waiting to be applied.
/// The payload is the new version string; the app toasts it (see
/// `src/app/nativeUpdate.ts`). Namespaced like the app's other shell events.
const UPDATE_READY_EVENT: &str = "crust://update-ready";

/// How often the shell looks again. Long enough to be invisible, short enough
/// that a day-long session still gets the release.
const UPDATE_RECHECK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(6 * 60 * 60);

/// First retry after a FAILED check, quadrupling up to the normal interval.
/// A launch that beats the network back online should not wait six hours.
const UPDATE_RETRY_MIN: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Default)]
struct OverlayState {
    click_through: Mutex<bool>,
}

/// An update already downloaded and verified against the public key in
/// `tauri.conf.json`, held until the app exits. Downloading eagerly but
/// installing at exit means the session is never interrupted: the installer
/// takes over an app that is already going away.
///
/// Every quit applies it, however the app was closed - so an update is never
/// downloaded twice. Note what that implies on Windows: the plugin passes the
/// install mode's NSIS args, and every unattended mode includes `/R` (Passive
/// is `["/P", "/R"]`, Quiet is `["/S", "/R"]`), with no way to drop it per
/// call. So a quit that applies an update relaunches the app afterwards. The
/// alternative, `basicUi`, passes no args and skips the relaunch but shows the
/// full installer UI instead.
#[derive(Default)]
struct StagedUpdate {
    ready: Mutex<Option<(Update, Vec<u8>)>>,
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
        .initialization_script(EVICT_LEGACY_SW_SCRIPT)
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

/// Quit so a staged update can be applied now rather than whenever the app
/// next closes. Exiting is the whole mechanism: the exit hook runs the
/// installer, which relaunches the app when it finishes. A no-op beyond a quit
/// when nothing is staged.
#[tauri::command]
fn restart_for_update(app: AppHandle) {
    app.exit(0);
}

/// The version waiting to be applied, if any. The webview asks once on mount:
/// the check runs during setup, so it can finish before any listener is
/// registered, and Tauri drops an event that nobody is listening for.
#[tauri::command]
fn pending_update_version(app: AppHandle) -> Option<String> {
    app.state::<StagedUpdate>()
        .ready
        .lock()
        .unwrap()
        .as_ref()
        .map(|(update, _)| update.version.clone())
}

fn apply_click_through(app: &AppHandle, on: bool) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.set_ignore_cursor_events(on);
    }
}

/// Record an updater diagnostic where it can actually be read.
///
/// stderr is not enough here: release builds carry
/// `windows_subsystem = "windows"` (no console attached), and the update path
/// runs ONLY in release builds, so every `eprintln!` on it is discarded by
/// construction. A mismatched signing key, a 404 manifest or a malformed
/// `latest.json` would otherwise stop every installed client updating, forever,
/// with no signal to anyone. The stderr write stays for `tauri dev`.
fn log_update(app: &AppHandle, message: &str) {
    eprintln!("[crust] {message}");
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("updater.log"))
    {
        use std::io::Write;
        let _ = writeln!(file, "{stamp} {message}");
    }
}

/// Check for an update and, if there is one, download it into `StagedUpdate`.
/// Called at startup and then on the re-check interval, off the main thread.
/// Every failure here is non-fatal
/// and invisible to the user - an unreachable endpoint, an offline machine or a
/// signature that does not verify must never stop the app from launching, and
/// the next launch simply tries again - but it is written to the updater log
/// (see `log_update`), so a permanently broken feed can be diagnosed rather
/// than merely suspected.
async fn stage_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let version = update.version.clone();
    // Already holding this exact version: nothing to do. Without this the loop
    // would re-download the same installer every interval, since `check()`
    // compares against the RUNNING version, not the staged one.
    if app
        .state::<StagedUpdate>()
        .ready
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(staged, _)| staged.version == version)
    {
        return Ok(());
    }
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    *app.state::<StagedUpdate>().ready.lock().unwrap() = Some((update, bytes));
    // Best-effort: a webview that has not booted yet (or has gone away) misses
    // this, which is what `pending_update_version` is for.
    let _ = app.emit(UPDATE_READY_EVENT, version);
    Ok(())
}

/// Run the installer for a staged update, if any. Called as the app exits, so
/// the installer takes over an app that is already going away rather than
/// interrupting a live session.
fn install_staged_update(app: &AppHandle) {
    let staged = app.state::<StagedUpdate>().ready.lock().unwrap().take();
    let Some((update, bytes)) = staged else {
        return;
    };
    // Only pre-launch failures (extraction, a bad temp path) can surface here:
    // on Windows the plugin hands off with ShellExecuteW, ignores its result and
    // exits the process, so a launch the shell refuses is silent either way.
    if let Err(e) = update.install(bytes) {
        log_update(app, &format!("failed to stage the update installer: {e}"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(OverlayState::default())
        .manage(StagedUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            restart_for_update,
            pending_update_version,
            mic_hotkey::set_mic_hotkey
        ])
        .setup(|app| {
            // The main window is built here rather than by the config (its
            // entry carries `create: false`) so the legacy-worker eviction
            // script can be attached: there is no config key for
            // initialization scripts. The rest of its definition stays in
            // tauri.conf.json.
            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no \"main\" window")?;
            WebviewWindowBuilder::from_config(app.handle(), &main_window)?
                .initialization_script(EVICT_LEGACY_SW_SCRIPT)
                .build()?;

            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let gs = app.global_shortcut();
            // Best-effort: a shortcut already held by another process must not
            // abort app startup. Log and continue so the app still launches.
            for accel in ["ctrl+shift+o", "ctrl+shift+l", "ctrl+shift+q"] {
                if let Err(e) = gs.register(accel) {
                    eprintln!("[crust] failed to register {accel}: {e}");
                }
            }
            // Check and download in the background: startup must not wait on
            // the network, and a failure must not abort it.
            //
            // Release builds only, and never when CRUST_NO_UPDATE is set.
            //
            // A `tauri dev` session reports the version in tauri.conf.json - the
            // same one a release is cut from - so once a newer release exists
            // every dev run would download it and, on the next quit, install the
            // released build over the dev session. The same is true of a local
            // `pnpm tauri build`, which IS a release build: that is the command
            // the README gives contributors for testing desktop changes, and
            // without an opt-out their own build quietly replaces itself with
            // the published one.
            // cfg!() rather than #[cfg]: the gate reads as one condition here
            // instead of spreading attributes over the imports, the event
            // constant and stage_update to keep a debug build warning-free.
            if !cfg!(debug_assertions) && std::env::var_os("CRUST_NO_UPDATE").is_none() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Re-checked, not checked once. Crust is built to be left
                    // running - the service worker prompt this mirrors exists
                    // for exactly those sessions - and a single startup check
                    // means a release published while the app is open is never
                    // seen, so the update only lands a restart later, or never.
                    // A FAILED check retries sooner than a successful one that
                    // found nothing. The likeliest failure is also the most
                    // transient - launching before the network is up, on
                    // autostart or resume - and treating it like "nothing new"
                    // would cost a whole interval of not looking.
                    let mut retry = UPDATE_RETRY_MIN;
                    loop {
                        let failed = match stage_update(handle.clone()).await {
                            Ok(()) => false,
                            Err(e) => {
                                log_update(&handle, &format!("update check failed: {e}"));
                                true
                            }
                        };
                        // Deliberately does NOT stop once something is staged.
                        // A user who clicks "Later" while 0.1.2 and 0.1.3 ship
                        // would otherwise install the stale 0.1.1 on quit and
                        // need a second restart to reach current; stage_update
                        // replaces the held bytes, and skips the download when
                        // the newest version is the one already staged.
                        if failed {
                            tokio::time::sleep(retry).await;
                            retry = (retry * 4).min(UPDATE_RECHECK_INTERVAL);
                        } else {
                            retry = UPDATE_RETRY_MIN;
                            tokio::time::sleep(UPDATE_RECHECK_INTERVAL).await;
                        }
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `build` + `run` rather than `run(context)`: the exit hook is where a
        // staged update gets applied.
        .run(|app, event| {
            if let RunEvent::Exit = event {
                install_staged_update(app);
            }
        });
}
