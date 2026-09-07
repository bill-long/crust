use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// Longer than the webview's call teardown cap. This fallback covers a crashed
// or unresponsive renderer, including a close before the app has booted.
const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Default, PartialEq, Debug)]
enum Phase {
    #[default]
    Running,
    Preparing,
    Ready,
    Exiting,
}

#[derive(Default)]
pub struct Shutdown(Mutex<Phase>);

impl Shutdown {
    fn begin(&self) -> bool {
        let mut phase = self.0.lock().unwrap();
        if *phase != Phase::Running {
            return false;
        }
        *phase = Phase::Preparing;
        true
    }

    fn complete(&self) -> bool {
        let mut phase = self.0.lock().unwrap();
        if *phase != Phase::Preparing {
            return false;
        }
        *phase = Phase::Ready;
        true
    }

    /// Consumed only by our explicit exit request, never by RunEvent::Exit
    /// (which Windows also sends during logoff and shutdown).
    pub fn take_exit(&self) -> bool {
        let mut phase = self.0.lock().unwrap();
        if *phase != Phase::Ready {
            return false;
        }
        *phase = Phase::Exiting;
        true
    }
}

pub fn request(app: &AppHandle) {
    if !app.state::<Shutdown>().begin() {
        return;
    }
    if let Err(error) = app.emit_to("main", "crust://prepare-shutdown", ()) {
        eprintln!("[crust] could not request call teardown: {error}");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHUTDOWN_TIMEOUT).await;
        complete(&app);
    });
}

pub fn complete(app: &AppHandle) {
    if app.state::<Shutdown>().complete() {
        app.exit(0);
    }
}

#[tauri::command]
pub fn complete_shutdown(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can complete shutdown".into());
    }
    complete(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_coordinated_quit_can_install() {
        let shutdown = Shutdown::default();
        assert!(!shutdown.take_exit());
        assert!(!shutdown.complete());
        assert!(shutdown.begin());
        assert!(!shutdown.begin());
        assert!(!shutdown.take_exit());
        assert!(shutdown.complete());
        assert!(!shutdown.complete());
        assert!(shutdown.take_exit());
        assert!(!shutdown.take_exit());
        assert!(!shutdown.begin());
    }
}
