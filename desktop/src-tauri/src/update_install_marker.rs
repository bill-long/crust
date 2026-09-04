use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct InstallAttempt {
    from_version: String,
    target_version: String,
}

/// Persist the handoff before the updater launches the installer.
///
/// A successful installer relaunches a different application version. If the
/// next process still reports `from_version`, the handoff did not finish and
/// the webview should tell the user instead of silently offering the same
/// update forever.
pub fn write(path: &Path, from_version: &str, target_version: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "install-attempt marker has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let marker = InstallAttempt {
        from_version: from_version.to_string(),
        target_version: target_version.to_string(),
    };
    let encoded = serde_json::to_vec(&marker).map_err(|e| e.to_string())?;
    std::fs::write(path, encoded).map_err(|e| e.to_string())
}

/// Return the target of an install attempt that left the old version running.
///
/// The marker stays until the user acknowledges the warning. A changed running
/// version proves that an install (or a manual replacement) happened, so that
/// stale marker is cleared without surfacing a false failure.
pub fn pending_failure(path: &Path, current_version: &str) -> Result<Option<String>, String> {
    let encoded = match std::fs::read(path) {
        Ok(encoded) => encoded,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let marker: InstallAttempt = match serde_json::from_slice(&encoded) {
        Ok(marker) => marker,
        Err(e) => {
            // A corrupt marker cannot identify a failed version and would fail
            // every launch forever. Drop it after recording the useful error.
            let _ = clear(path);
            return Err(e.to_string());
        }
    };
    if marker.from_version != current_version {
        clear(path)?;
        return Ok(None);
    }
    Ok(Some(marker.target_version))
}

pub fn clear(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("crust-update-marker-{}-{id}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn marker(&self) -> std::path::PathBuf {
            self.0.join("pending-update-install.json")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn same_version_reports_failure_until_acknowledged() {
        let dir = TestDir::new();
        let path = dir.marker();
        write(&path, "0.2.3", "0.2.4").unwrap();

        assert_eq!(
            pending_failure(&path, "0.2.3").unwrap(),
            Some("0.2.4".to_string())
        );
        assert!(path.exists());

        clear(&path).unwrap();
        assert_eq!(pending_failure(&path, "0.2.3").unwrap(), None);
    }

    #[test]
    fn changed_version_clears_a_successful_attempt() {
        let dir = TestDir::new();
        let path = dir.marker();
        write(&path, "0.2.3", "0.2.4").unwrap();

        assert_eq!(pending_failure(&path, "0.2.4").unwrap(), None);
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_marker_is_removed_instead_of_poisoning_every_launch() {
        let dir = TestDir::new();
        let path = dir.marker();
        std::fs::write(&path, b"not json").unwrap();

        assert!(pending_failure(&path, "0.2.3").is_err());
        assert!(!path.exists());
    }
}
