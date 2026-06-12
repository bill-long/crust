/**
 * Browser-mode tests for the composer's Phase 2 attach-file entry point
 * (issue #276): the hidden file input behind the 📎 button, and the
 * `onEnqueueReady` seam the room view's drag-and-drop overlay feeds.
 *
 * Runs in headless Chromium because real `File`/`DataTransfer`/object-URL
 * support and an assignable `input.files` are needed.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";
import type { TimelineEvent } from "../timeline/useTimeline";

// Composer pulls GIF config from ConfigProvider; stub it so tests don't need
// a real config.json fetch. GIF search disabled keeps the GIF button hidden.
vi.mock("../../gif/gifConfig", () => ({
	useGifConfig: () => ({
		available: () => false,
		provider: () => "tenor",
		apiKey: () => "",
		trendingOnOpen: () => false,
		maxRating: () => "off",
		autoDownload: () => false,
	}),
}));

const { Composer } = await import("./Composer");

const ROOM = "!room:example.com";
const ENC_ROOM = "!enc:example.com";

function makeClient() {
	const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
	rooms.set(
		ROOM,
		createMockRoom(ROOM, [], [{ userId: "@test:example.com", name: "Test" }]),
	);
	const enc = createMockRoom(ENC_ROOM, []);
	enc.__setEncrypted(true);
	rooms.set(ENC_ROOM, enc);
	return createMockClient(rooms);
}

/** Set an `<input type=file>`'s FileList and fire its change event. */
function pickFiles(input: HTMLInputElement, files: File[]): void {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	input.files = dt.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => cleanup());

describe("Composer attach-file button", () => {
	it("queues an image chosen via the file input, with a preview", async () => {
		const { container, findByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));

		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		expect(input).toBeTruthy();
		if (!input) return;

		pickFiles(input, [
			new File(["fake-png-bytes"], "photo.png", { type: "image/png" }),
		]);

		// Tray row appears (remove button is labelled with the file name).
		await findByLabelText("Remove photo.png");
		// Image kind mints an object-URL preview <img>.
		expect(container.querySelector("img")).toBeTruthy();
	});

	it("queues an arbitrary file as a non-image (m.file) attachment", async () => {
		const { container, findByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("no file input");

		pickFiles(input, [
			new File(["plain text"], "notes.txt", { type: "text/plain" }),
		]);

		await findByLabelText("Remove notes.txt");
		// Non-image kinds have no object-URL preview, so the tray shows the
		// icon fallback rather than an <img>.
		expect(container.querySelector("img")).toBeNull();
	});

	it("resets the input value so the same file can be re-picked", async () => {
		const { container, findByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("no file input");

		pickFiles(input, [new File(["a"], "doc.pdf", { type: "application/pdf" })]);
		await findByLabelText("Remove doc.pdf");
		expect(input.value).toBe("");
	});

	it("rejects files in an encrypted room (Phase 0 gate) and queues nothing", async () => {
		const { container, findByRole, queryByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ENC_ROOM} packs={[]} />
			</TestClientProvider>
		));
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("no file input");

		pickFiles(input, [new File(["a"], "secret.png", { type: "image/png" })]);

		const alert = await findByRole("alert");
		expect(alert.textContent ?? "").toMatch(/encrypted rooms isn't supported/i);
		expect(queryByLabelText("Remove secret.png")).toBeNull();
	});

	it("ignores files enqueued via the seam while editing", async () => {
		let enqueue: ((files: Iterable<File>) => void) | undefined;
		const editingEvent = {
			eventId: "$e1",
			body: "old text",
		} as unknown as TimelineEvent;

		const { queryByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer
					roomId={ROOM}
					packs={[]}
					editingEvent={editingEvent}
					onEnqueueReady={(fn) => {
						enqueue = fn;
					}}
				/>
			</TestClientProvider>
		));

		await tick(); // let onMount register the seam
		expect(enqueue).toBeTypeOf("function");
		enqueue?.([new File(["a"], "drop.png", { type: "image/png" })]);
		await tick();

		expect(queryByLabelText("Remove drop.png")).toBeNull();
	});
});
