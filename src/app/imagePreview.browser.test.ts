import { waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { openImagePreview } from "./imagePreview";

const windows: Window[] = [];
afterEach(() => {
	for (const window of windows.splice(0)) window.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("reserves a tab before a slow fetch and renders SVG only as an image", async () => {
	const realOpen = window.open.bind(window);
	vi.spyOn(window, "open").mockImplementation((...args) => {
		const tab = realOpen(...args);
		if (tab) windows.push(tab);
		return tab;
	});
	let resolve!: (blob: Blob) => void;
	const pending = openImagePreview(
		() =>
			new Promise<Blob>((r) => {
				resolve = r;
			}),
		new AbortController().signal,
	);
	const tab = windows[0];
	if (!tab) throw new Error("Preview did not create a window");
	expect(tab.opener).toBeNull();
	expect(tab.document.body.textContent).toContain("Loading");
	resolve(
		new Blob(
			[
				'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.pwned=true</script></svg>',
			],
			{ type: "image/svg+xml" },
		),
	);
	await pending;
	await waitFor(() =>
		expect(tab.document.querySelector("img")?.naturalWidth).toBe(10),
	);
	expect(tab.document.querySelector("script")).toBeNull();
	expect((tab as Window & { pwned?: boolean }).pwned).toBeUndefined();
	const url = tab.document.querySelector("img")?.src;
	if (!url) throw new Error("Missing image URL");
	expect((await fetch(url)).ok).toBe(true);
	expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
});

it("closes an unfinished tab on cancellation and surfaces blocked popups", async () => {
	const realOpen = window.open.bind(window);
	const tab = realOpen("about:blank");
	if (!tab) throw new Error("Preview window unavailable");
	windows.push(tab);
	vi.spyOn(window, "open").mockReturnValue(tab);
	const abort = new AbortController();
	let resolve!: (blob: Blob) => void;
	const pending = openImagePreview(
		() =>
			new Promise<Blob>((r) => {
				resolve = r;
			}),
		abort.signal,
	);
	abort.abort();
	expect(tab.closed).toBe(true);
	resolve(new Blob());
	await expect(pending).rejects.toThrow();
	vi.mocked(window.open).mockReturnValue(null);
	const load = vi.fn();
	await expect(
		openImagePreview(load, new AbortController().signal),
	).rejects.toThrow("Allow popups");
	expect(load).not.toHaveBeenCalled();
});

it("hands bytes to the desktop viewer without opening an external media URL", async () => {
	vi.stubGlobal("isTauri", true);
	const invoke = vi.fn(async () => undefined);
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	const open = vi.spyOn(window, "open");
	await openImagePreview(
		async () => new Blob(["bytes"], { type: "image/png" }),
		new AbortController().signal,
	);
	expect(invoke).toHaveBeenCalledWith("open_image_preview", {
		dataUrl: "data:image/png;base64,Ynl0ZXM=",
	});
	expect(open).not.toHaveBeenCalled();
});

it("keeps an image opened as a document isolated from the app origin", async () => {
	const realOpen = window.open.bind(window);
	vi.spyOn(window, "open").mockImplementation((...args) => {
		const tab = realOpen(...args);
		if (tab) windows.push(tab);
		return tab;
	});
	await openImagePreview(
		async () =>
			new Blob(
				[
					`<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage({kind:"preview-origin-check"},"*")</script></svg>`,
				],
				{ type: "image/svg+xml" },
			),
		new AbortController().signal,
	);
	const src = windows[0]?.document.querySelector("img")?.src;
	if (!src) throw new Error("Missing preview image");
	const frame = document.createElement("iframe");
	let origin: string | undefined;
	const receive = (event: MessageEvent) => {
		if (
			event.source === frame.contentWindow &&
			event.data?.kind === "preview-origin-check"
		)
			origin = event.origin;
	};
	window.addEventListener("message", receive);
	try {
		frame.src = src;
		document.body.append(frame);
		await waitFor(() => expect(origin).toBeDefined());
		expect(origin).toBe("null");
	} finally {
		frame.remove();
		window.removeEventListener("message", receive);
	}
});
