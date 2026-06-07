/**
 * Feature detection for the Document Picture-in-Picture API
 * (https://developer.mozilla.org/docs/Web/API/Document_Picture-in-Picture_API).
 *
 * Available in Chromium 116+ (desktop only). Absent in Firefox and Safari, so
 * the overlay trigger must be hidden when this returns false.
 */

interface DocumentPipWindowOptions {
	width?: number;
	height?: number;
	disallowReturnToOpener?: boolean;
	preferInitialWindowPlacement?: boolean;
}

export interface DocumentPictureInPicture extends EventTarget {
	readonly window: Window | null;
	requestWindow(options?: DocumentPipWindowOptions): Promise<Window>;
}

/** True when the current browser exposes `documentPictureInPicture`. */
export function isDocumentPipSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		"documentPictureInPicture" in window &&
		typeof (
			window as unknown as {
				documentPictureInPicture?: { requestWindow?: unknown };
			}
		).documentPictureInPicture?.requestWindow === "function"
	);
}

/** Narrowed accessor for the global, or null when unsupported. */
export function getDocumentPip(): DocumentPictureInPicture | null {
	if (!isDocumentPipSupported()) return null;
	return (
		window as unknown as { documentPictureInPicture: DocumentPictureInPicture }
	).documentPictureInPicture;
}
