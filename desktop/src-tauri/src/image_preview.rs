use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static NEXT_PREVIEW: AtomicU64 = AtomicU64::new(0);

fn preview_script(data_url: &str) -> Result<String, String> {
    let (header, bytes) = data_url.split_once(',').ok_or("Invalid image")?;
    // FileReader generates base64. No remote URLs or document markup crosses
    // this boundary, and even SVG is rendered in img's non-scriptable context.
    if !header.starts_with("data:")
        || !header.ends_with(";base64")
        || !bytes
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
    {
        return Err("Invalid image".into());
    }
    let source = serde_json::to_string(data_url).map_err(|e| e.to_string())?;
    Ok(format!(
        "document.title='Image - Crust'; document.documentElement.style.colorScheme='dark'; \
         const img=document.createElement('img'); img.alt='Image'; \
         img.onerror=()=>{{document.body.textContent=\"Couldn't display this image.\"}}; \
         img.src={source}; document.body.replaceChildren(img);"
    ))
}

/// In-memory viewer with no app origin, navigation, or IPC capabilities.
#[tauri::command]
pub async fn open_image_preview(
    app: AppHandle,
    window: WebviewWindow,
    data_url: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Image previews must be opened from the main window".into());
    }
    let script = preview_script(&data_url)?;
    let label = format!(
        "image-preview-{}",
        NEXT_PREVIEW.fetch_add(1, Ordering::Relaxed)
    );
    let viewer = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::External("about:blank".parse().map_err(|_| "Invalid preview URL")?),
    )
    .title("Image - Crust")
    .inner_size(960.0, 720.0)
    .on_navigation(|url| url.as_str() == "about:blank")
    .build()
    .map_err(|e| e.to_string())?;
    // about:blank is WebView2's initial document and emits no navigation
    // completion callback. Evaluate after creation instead of waiting for one.
    if let Err(error) = viewer.eval(&script) {
        if let Err(close_error) = viewer.close() {
            eprintln!("[crust] failed to close an uninitialized preview: {close_error}");
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_only_accepts_encoded_bytes_and_renders_them_as_an_image() {
        for invalid in [
            "https://example.com/image",
            "data:image/png;base64,\";alert(1)",
            "data:text/html,<script>",
        ] {
            assert!(preview_script(invalid).is_err());
        }
        let script = preview_script("data:image/svg+xml;base64,PHN2Zz4=").unwrap();
        assert!(script.contains("document.createElement('img')"));
        assert!(!script.contains("innerHTML"));
    }
}
