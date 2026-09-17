/// Only the main webview owns the install's unread count. The voice overlay
/// must never clear or overwrite it with its independent window state.
#[tauri::command]
pub fn set_app_badge(
    window: tauri::WebviewWindow,
    count: u32,
    rgba: Option<Vec<u8>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can update the app badge".into());
    }
    #[cfg(target_os = "windows")]
    {
        // Tauri's numeric badge API is unsupported on Windows. Taskbar overlays
        // use RGBA images instead; None removes the overlay when all is read.
        let icon = if count == 0 {
            None
        } else {
            let pixels = rgba.ok_or("Missing badge image")?;
            if pixels.len() != 32 * 32 * 4 {
                return Err("Badge image must be 32 by 32 RGBA pixels".into());
            }
            Some(tauri::image::Image::new_owned(pixels, 32, 32))
        };
        window.set_overlay_icon(icon).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = rgba;
        window
            .set_badge_count((count > 0).then_some(i64::from(count)))
            .map_err(|e| e.to_string())
    }
}
