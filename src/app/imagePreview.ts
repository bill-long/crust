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
		if (native) {
			if (!tauriIpcAvailable())
				throw new Error("Image preview is unavailable.");
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error("Couldn't open this image."));
				reader.readAsDataURL(blob);
			});
			signal.throwIfAborted();
			await invokeTauri("open_image_preview", { dataUrl });
		} else if (tab && !tab.closed) {
			const urls = (tab as Window & Pick<typeof globalThis, "URL">).URL;
			const url = urls.createObjectURL(blob);
			const img = tab.document.createElement("img");
			img.alt = "Image";
			// The viewer owns the URL so it survives closing the source tab.
			// Keep it usable for Save image as until the viewer closes.
			const release = () => urls.revokeObjectURL(url);
			img.onerror = () => {
				release();
				tab.document.body.textContent = "Couldn't display this image.";
			};
			tab.addEventListener("pagehide", release, { once: true });
			img.src = url;
			tab.document.body.replaceChildren(img);
		}
	} catch (error) {
		tab?.close();
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
