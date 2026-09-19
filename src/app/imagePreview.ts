import { isNativeShell } from "./nativeShell";
import { invokeTauri, tauriIpcAvailable } from "./tauri";

/** Reserve a browser tab during the click, before fetching loses user activation.
 * Render bytes only as an image, never as a navigable HTML/SVG document. */
export async function openImagePreview(
	load: () => Promise<Blob>,
	signal: AbortSignal,
): Promise<void> {
	const native = isNativeShell();
	const tab = native ? null : window.open("about:blank", "_blank");
	if (!native && !tab) throw new Error("Allow popups to open this image.");
	if (tab) {
		tab.opener = null;
		tab.document.title = "Image - Crust";
		tab.document.body.textContent = "Loading image…";
		tab.document.documentElement.style.colorScheme = "dark";
	}
	const cancel = () => tab?.close();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		const blob = await load();
		signal.throwIfAborted();
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(new Error("Couldn't open this image."));
			reader.readAsDataURL(blob);
		});
		signal.throwIfAborted();
		if (native) {
			if (!tauriIpcAvailable())
				throw new Error("Image preview is unavailable.");
			const label = await invokeTauri<string>("open_image_preview", {
				dataUrl,
			});
			if (signal.aborted) {
				await invokeTauri("close_image_preview", { label });
				signal.throwIfAborted();
			}
		} else if (tab && !tab.closed) {
			const img = tab.document.createElement("img");
			img.alt = "Image";
			// Data URLs have an opaque origin even if opened as SVG documents from
			// the image context menu. App-origin Blob URLs would expose app storage.
			img.onerror = () => {
				tab.document.body.textContent = "Couldn't display this image.";
			};
			img.src = dataUrl;
			tab.document.body.replaceChildren(img);
		}
	} catch (error) {
		tab?.close();
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
