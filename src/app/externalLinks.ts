import { reportError } from "../lib/reportError";
import { isNativeShell } from "./nativeShell";
import { invokeTauri, tauriIpcAvailable } from "./tauri";

// External applications for the schemes accepted in Matrix message links.
// mxc is a media identifier, not an external application protocol.
export const EXTERNAL_PROTOCOLS = [
	"http:",
	"https:",
	"mailto:",
	"tel:",
	"xmpp:",
	"geo:",
	"magnet:",
	"matrix:",
];

function externalUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return EXTERNAL_PROTOCOLS.includes(url.protocol) ? url : null;
	} catch {
		return null;
	}
}

export async function openExternalUrl(value: string): Promise<void> {
	const url = externalUrl(value);
	if (!url) {
		throw new Error("This link cannot be opened in a browser.");
	}
	if (isNativeShell()) {
		if (!tauriIpcAvailable())
			throw new Error("Desktop browser opening is unavailable.");
		await invokeTauri("plugin:opener|open_url", { url: url.href });
	} else {
		window.open(url.href, "_blank", "noopener,noreferrer");
	}
}

/** Run after document delegates so image viewers and Matrix routing win. */
export function watchExternalLinks(): () => void {
	if (!isNativeShell()) return () => {};
	const onClick = (event: MouseEvent) => {
		if (event.defaultPrevented || (event.button !== 0 && event.button !== 1))
			return;
		const anchor =
			event.target instanceof Element
				? event.target.closest<HTMLAnchorElement>("a[href]")
				: null;
		if (!anchor || anchor.hasAttribute("download")) return;
		const url = externalUrl(anchor.href);
		if (!url) return;
		if (url.origin === location.origin && anchor.target !== "_blank") return;
		event.preventDefault();
		void openExternalUrl(url.href).catch((error) =>
			reportError(error, {
				userMessage: "Couldn't open the link in your browser.",
				logLabel: "Opening external link",
			}),
		);
	};
	window.addEventListener("click", onClick);
	window.addEventListener("auxclick", onClick);
	return () => {
		window.removeEventListener("click", onClick);
		window.removeEventListener("auxclick", onClick);
	};
}
