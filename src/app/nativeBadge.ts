import { invokeTauri } from "./tauri";

/** Windows needs an overlay image; other desktop platforms use the count. */
export async function writeNativeBadge(count: number): Promise<void> {
	const unread = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	let rgba: number[] | null = null;
	if (unread > 0) {
		// Canvas supplies antialiased text without adding a native font dependency.
		// Keep this tiny, independent of the user's in-app zoom.
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 32;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Badge canvas is unavailable");
		const style = getComputedStyle(document.documentElement);
		context.fillStyle = style.getPropertyValue("--color-danger").trim();
		context.beginPath();
		context.arc(16, 16, 16, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = style
			.getPropertyValue("--color-danger-foreground")
			.trim();
		context.font = `bold ${unread > 99 ? 15 : 20}px sans-serif`;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(unread > 99 ? "99+" : String(unread), 16, 17);
		rgba = Array.from(context.getImageData(0, 0, 32, 32).data);
	}
	await invokeTauri("set_app_badge", { count: unread, rgba });
}
