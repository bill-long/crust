/**
 * Browser-mode tests for the composer's Phase 2 attach-file entry point
 * (issue #276): the hidden file input behind the attach button, and the
 * `onEnqueueReady` seam the room view's drag-and-drop overlay feeds.
 *
 * Runs in headless Chromium because real `File`/`DataTransfer`/object-URL
 * support and an assignable `input.files` are needed.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
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

	it("queues files in an encrypted room (Phase 4: send path encrypts them)", async () => {
		const { container, findByLabelText, queryByRole } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ENC_ROOM} packs={[]} />
			</TestClientProvider>
		));
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("no file input");

		pickFiles(input, [new File(["a"], "secret.png", { type: "image/png" })]);

		// The attachment queues like any other room — no "unsupported" error.
		await findByLabelText("Remove secret.png");
		expect(queryByRole("alert")).toBeNull();
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

describe("Composer caption input", () => {
	it("waits for editing to end before retrying a voice upload that failed mid-edit", async () => {
		const ctx = new AudioContext();
		const oscillator = ctx.createOscillator();
		const destination = ctx.createMediaStreamDestination();
		oscillator.connect(destination);
		oscillator.start();
		const microphone = vi
			.spyOn(navigator.mediaDevices, "getUserMedia")
			.mockResolvedValue(destination.stream);
		try {
			const client = makeClient();
			let rejectUpload!: (error: Error) => void;
			client.uploadContent.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						rejectUpload = reject;
					}),
			);
			const [editing, setEditing] = createSignal<TimelineEvent | null>(null);
			const { getByLabelText, findByLabelText } = render(() => (
				<TestClientProvider client={client}>
					<Composer
						roomId={ROOM}
						packs={[]}
						editingEvent={editing()}
						onCancelEdit={() => setEditing(null)}
					/>
				</TestClientProvider>
			));
			await userEvent.click(getByLabelText("Message actions"));
			const record = [
				...document.body.querySelectorAll('[role="menuitem"]'),
			].find((el) => el.textContent?.trim() === "Record voice message");
			if (!record) throw new Error("record item missing");
			await userEvent.click(record);
			await userEvent.click(await findByLabelText("Send voice message"));
			await expect.poll(() => client.uploadContent.mock.calls.length).toBe(1);
			setEditing({
				eventId: "$editing",
				body: "Unfinished edit",
			} as TimelineEvent);
			// Entering edit mode focuses the message on the next frame. Let that
			// finish before filling the caption, or browser fill can type into
			// the message when focus moves between selecting and inserting text.
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			rejectUpload(new Error("Upload failed"));
			const caption = await findByLabelText("Caption for Voice message.webm");
			await userEvent.fill(caption, "Keep the recording");
			expect((caption as HTMLInputElement).value).toBe("Keep the recording");
			expect(
				(getByLabelText("Edit message") as HTMLTextAreaElement).value,
			).toBe("Unfinished edit");
			expect(document.activeElement).toBe(caption);
			await userEvent.keyboard("{Enter}");
			expect(client.sendMessage).not.toHaveBeenCalled();
			expect(
				(getByLabelText("Send attachments") as HTMLButtonElement).disabled,
			).toBe(true);
			await userEvent.click(getByLabelText("Cancel edit"));
			await userEvent.click(caption);
			await userEvent.keyboard("{Enter}");
			await expect.poll(() => client.sendMessage.mock.calls.length).toBe(1);
			expect(client.sendMessage).toHaveBeenCalledWith(
				ROOM,
				null,
				expect.objectContaining({
					msgtype: "m.audio",
					body: "Keep the recording",
				}),
			);
		} finally {
			cleanup();
			microphone.mockRestore();
			await ctx.close();
		}
	});

	it("keeps a failed attachment retryable and prevents duplicate pending sends", async () => {
		const client = makeClient();
		let rejectUpload!: (error: Error) => void;
		client.uploadContent.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectUpload = reject;
				}),
		);
		const {
			container,
			findByLabelText,
			getByLabelText,
			findByRole,
			queryByLabelText,
		} = render(() => (
			<TestClientProvider client={client}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("file input missing");
		pickFiles(input, [
			new File(["notes"], "notes.txt", { type: "text/plain" }),
		]);
		const caption = await findByLabelText("Caption for notes.txt");
		await userEvent.fill(caption, "Keep this caption");
		await userEvent.keyboard("{Enter}");
		await expect.poll(() => client.uploadContent.mock.calls.length).toBe(1);
		expect(
			(getByLabelText("Send attachments") as HTMLButtonElement).disabled,
		).toBe(true);
		const textarea = container.querySelector<HTMLTextAreaElement>(
			"[data-composer-textarea]",
		);
		if (!textarea) throw new Error("textarea missing");
		await userEvent.click(textarea);
		await userEvent.keyboard("{Enter}");
		expect(client.uploadContent).toHaveBeenCalledTimes(1);
		rejectUpload(new Error("Upload failed"));
		await findByRole("alert");
		expect((caption as HTMLInputElement).value).toBe("Keep this caption");
		await userEvent.click(getByLabelText("Send attachments"));
		await expect.poll(() => client.sendMessage.mock.calls.length).toBe(1);
		expect(queryByLabelText("Remove notes.txt")).toBeNull();
	});

	it.each(["caption Enter", "message Enter", "Send button"])(
		"sends a selected file with %s",
		async (method) => {
			const client = makeClient();
			const { container, getByLabelText, findByLabelText, queryByLabelText } =
				render(() => (
					<TestClientProvider client={client}>
						<Composer roomId={ROOM} packs={[]} />
					</TestClientProvider>
				));
			const input = container.querySelector<HTMLInputElement>(
				"input[data-composer-file-input]",
			);
			if (!input) throw new Error("file input missing");
			input.addEventListener("click", (e) => e.preventDefault());
			await userEvent.click(getByLabelText("Message actions"));
			const item = [
				...document.body.querySelectorAll('[role="menuitem"]'),
			].find((el) => el.textContent?.trim() === "Attach file");
			if (!item) throw new Error("attach item missing");
			await userEvent.click(item);
			pickFiles(input, [
				new File(["notes"], "notes.txt", { type: "text/plain" }),
			]);
			const caption = await findByLabelText("Caption for notes.txt");
			await userEvent.fill(caption, "File caption");
			for (const modifier of [{ shiftKey: true }, { isComposing: true }]) {
				const event = new KeyboardEvent("keydown", {
					key: "Enter",
					bubbles: true,
					cancelable: true,
					...modifier,
				});
				caption.dispatchEvent(event);
				expect(event.defaultPrevented).toBe(false);
			}
			expect(client.uploadContent).not.toHaveBeenCalled();
			if (method === "Send button") {
				await userEvent.click(getByLabelText("Send attachments"));
			} else {
				if (method === "message Enter") {
					const textarea = container.querySelector<HTMLTextAreaElement>(
						"[data-composer-textarea]",
					);
					if (!textarea) throw new Error("textarea missing");
					await userEvent.click(textarea);
				}
				await userEvent.keyboard("{Enter}");
			}
			await expect.poll(() => client.sendMessage.mock.calls.length).toBe(1);
			expect(client.sendMessage).toHaveBeenCalledWith(
				ROOM,
				null,
				expect.objectContaining({
					filename: "notes.txt",
					body: "File caption",
					msgtype: "m.file",
				}),
			);
			expect(queryByLabelText("Remove notes.txt")).toBeNull();
		},
	);

	// Regression: the tray iterated attachments with a reference-keyed <For>, but
	// updateAttachment used to replace the attachment object wholesale, so every
	// caption keystroke minted a new reference and <For> remounted the row,
	// dropping the input's focus (the user had to re-click the box per character).
	// The queue is now a store mutated in place, so the row's reference - and its
	// DOM node - is stable across edits.
	it("keeps focus while typing a caption, character by character", async () => {
		const { container, findByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));

		const fileInput = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!fileInput) throw new Error("file input missing");
		pickFiles(fileInput, [
			new File(["fake-png-bytes"], "photo.png", { type: "image/png" }),
		]);

		const caption = (await findByLabelText(
			"Caption for photo.png",
		)) as HTMLInputElement;
		caption.focus();
		expect(document.activeElement).toBe(caption);

		// Type three characters the way a browser does: mutate value, fire input.
		for (const ch of "cat") {
			caption.value += ch;
			caption.dispatchEvent(new Event("input", { bubbles: true }));
			await tick();
			// The same node must survive each keystroke, still connected and focused.
			expect(caption.isConnected).toBe(true);
			expect(document.activeElement).toBe(caption);
		}
		expect(caption.value).toBe("cat");
	});

	// Reference-keying (the reason we kept <For> over <Index>): removing an
	// earlier attachment must move the surviving rows' nodes, not rebind fresh
	// nodes by position - otherwise a caption being typed in a later row loses its
	// focus/caret. The send loop removes attachments one-by-one as they upload, so
	// this path is real.
	it("keeps focus in a later caption when an earlier attachment is removed", async () => {
		const { container, findByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));

		const fileInput = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!fileInput) throw new Error("file input missing");
		pickFiles(fileInput, [
			new File(["a"], "first.png", { type: "image/png" }),
			new File(["b"], "second.png", { type: "image/png" }),
		]);

		const secondCaption = (await findByLabelText(
			"Caption for second.png",
		)) as HTMLInputElement;
		secondCaption.value = "hi";
		secondCaption.dispatchEvent(new Event("input", { bubbles: true }));
		secondCaption.focus();
		expect(document.activeElement).toBe(secondCaption);

		// Remove the first (upper) attachment via its tray control.
		((await findByLabelText("Remove first.png")) as HTMLButtonElement).click();
		await tick();

		// The second row's input node survives the removal with its focus + value.
		expect(secondCaption.isConnected).toBe(true);
		expect(document.activeElement).toBe(secondCaption);
		expect(secondCaption.value).toBe("hi");
	});
});

describe("Composer formatting toolbar", () => {
	/** Get the composer textarea. */
	function getTextarea(container: HTMLElement): HTMLTextAreaElement {
		const ta = container.querySelector<HTMLTextAreaElement>(
			"[data-composer-textarea]",
		);
		if (!ta) throw new Error("no textarea");
		return ta;
	}

	/** Set the controlled textarea's value via a real input event. */
	function typeValue(ta: HTMLTextAreaElement, value: string): void {
		ta.value = value;
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}

	it("exposes a labelled toolbar with formatting buttons", () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const toolbar = container.querySelector('[role="toolbar"]');
		expect(toolbar?.getAttribute("aria-label")).toBe("Text formatting");
		for (const label of [
			"Bold (Ctrl/Cmd+B)",
			"Italic (Ctrl/Cmd+I)",
			"Strikethrough (Ctrl/Cmd+Shift+X)",
			"Inline code (Ctrl/Cmd+E)",
			"Link",
			"Bulleted list",
			"Quote",
		]) {
			expect(getByLabelText(label)).toBeTruthy();
		}
	});

	it("wraps the current selection in ** when Bold is clicked", async () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		typeValue(ta, "hello world");
		ta.focus();
		ta.setSelectionRange(0, 5); // "hello"
		(getByLabelText("Bold (Ctrl/Cmd+B)") as HTMLButtonElement).click();
		await tick();
		expect(ta.value).toBe("**hello** world");
	});

	it("prefixes selected lines with '- ' when Bulleted list is clicked", async () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		typeValue(ta, "a\nb");
		ta.focus();
		ta.setSelectionRange(0, 3); // both lines
		(getByLabelText("Bulleted list") as HTMLButtonElement).click();
		await tick();
		expect(ta.value).toBe("- a\n- b");
	});

	it("keeps a collapsed caret after the prefix when there is no selection", async () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		typeValue(ta, "ab");
		ta.focus();
		ta.setSelectionRange(2, 2); // collapsed caret at end, no selection
		(getByLabelText("Quote") as HTMLButtonElement).click();
		// Selection restore happens in a rAF, so wait a frame before asserting it.
		await new Promise<void>((r) => requestAnimationFrame(() => r()));
		expect(ta.value).toBe("> ab");
		// Caret stays at the original position shifted by the "> " prefix (2),
		// collapsed — so the next keystroke continues typing, not overwrites.
		expect(ta.selectionStart).toBe(4);
		expect(ta.selectionEnd).toBe(4);
	});

	it("wraps the selection on Ctrl+B", async () => {
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		typeValue(ta, "word");
		ta.focus();
		ta.setSelectionRange(0, 4);
		ta.dispatchEvent(
			new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }),
		);
		await tick();
		expect(ta.value).toBe("**word**");
	});
});

describe("Composer preview toggle", () => {
	function getTextarea(container: HTMLElement): HTMLTextAreaElement {
		const ta = container.querySelector<HTMLTextAreaElement>(
			"[data-composer-textarea]",
		);
		if (!ta) throw new Error("no textarea");
		return ta;
	}

	function typeValue(ta: HTMLTextAreaElement, value: string): void {
		ta.value = value;
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}

	it("renders the draft through MessageBody only while the preview is open", async () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		typeValue(ta, "**bold**");

		// Hidden by default.
		expect(
			container.querySelector('[aria-label="Message preview"]'),
		).toBeNull();

		(getByLabelText("Preview") as HTMLButtonElement).click();
		await tick();

		const region = container.querySelector('[aria-label="Message preview"]');
		expect(region).not.toBeNull();
		// Byte-identical to the receive path: the formatted_body renders <strong>.
		expect(region?.querySelector("strong")?.textContent).toBe("bold");
	});

	it("reflects open/closed state via aria-pressed", async () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		getTextarea(container); // ensure mounted
		const btn = getByLabelText("Preview") as HTMLButtonElement;
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		btn.click();
		await tick();
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		btn.click();
		await tick();
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		expect(
			container.querySelector('[aria-label="Message preview"]'),
		).toBeNull();
	});

	it("shows a placeholder when the draft is empty", async () => {
		const { container, getByLabelText } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} />
			</TestClientProvider>
		));
		getTextarea(container);
		(getByLabelText("Preview") as HTMLButtonElement).click();
		await tick();
		const region = container.querySelector('[aria-label="Message preview"]');
		expect(region?.textContent).toContain("Nothing to preview");
	});
});

describe("Composer edit-last shortcut (Up arrow)", () => {
	function getTextarea(container: HTMLElement): HTMLTextAreaElement {
		const ta = container.querySelector<HTMLTextAreaElement>(
			"[data-composer-textarea]",
		);
		if (!ta) throw new Error("no textarea");
		return ta;
	}

	function typeValue(ta: HTMLTextAreaElement, value: string): void {
		ta.value = value;
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** Dispatch an ArrowUp keydown and report whether preventDefault fired. */
	function pressArrowUp(
		ta: HTMLTextAreaElement,
		modifiers: KeyboardEventInit = {},
	): boolean {
		const e = new KeyboardEvent("keydown", {
			key: "ArrowUp",
			bubbles: true,
			cancelable: true,
			...modifiers,
		});
		ta.dispatchEvent(e);
		return e.defaultPrevented;
	}

	const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

	it("requests edit-last when Up is pressed in an empty composer", () => {
		const onEditLast = vi.fn();
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} onEditLast={onEditLast} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		ta.focus();
		const prevented = pressArrowUp(ta);
		expect(onEditLast).toHaveBeenCalledTimes(1);
		expect(prevented).toBe(true);
	});

	it("does not hijack Up when the composer has a draft", () => {
		const onEditLast = vi.fn();
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} onEditLast={onEditLast} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		typeValue(ta, "a multi\nline draft");
		ta.focus();
		const prevented = pressArrowUp(ta);
		expect(onEditLast).not.toHaveBeenCalled();
		expect(prevented).toBe(false);
	});

	it("does not request edit-last while already editing", () => {
		const onEditLast = vi.fn();
		const editing = {
			eventId: "$e:example.com",
			body: "old text",
		} as unknown as TimelineEvent;
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer
					roomId={ROOM}
					packs={[]}
					editingEvent={editing}
					onEditLast={onEditLast}
				/>
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		// Edit mode prefills the textarea, so clear it to isolate the guard.
		typeValue(ta, "");
		ta.focus();
		pressArrowUp(ta);
		expect(onEditLast).not.toHaveBeenCalled();
	});

	it("does not request edit-last for a modified Up (Shift/Ctrl/Alt/Meta)", () => {
		const onEditLast = vi.fn();
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} onEditLast={onEditLast} />
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		ta.focus();
		for (const mod of [
			{ shiftKey: true },
			{ ctrlKey: true },
			{ altKey: true },
			{ metaKey: true },
		]) {
			const prevented = pressArrowUp(ta, mod);
			expect(prevented).toBe(false);
		}
		expect(onEditLast).not.toHaveBeenCalled();
	});

	it("does not clobber a pending reply with Up", () => {
		const onEditLast = vi.fn();
		const replyTo = {
			eventId: "$parent:example.com",
			senderId: "@bob:example.com",
			senderName: "Bob",
			body: "parent",
		} as unknown as TimelineEvent;
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer
					roomId={ROOM}
					packs={[]}
					replyTo={replyTo}
					onEditLast={onEditLast}
				/>
			</TestClientProvider>
		));
		const ta = getTextarea(container);
		ta.focus();
		const prevented = pressArrowUp(ta);
		expect(onEditLast).not.toHaveBeenCalled();
		expect(prevented).toBe(false);
	});

	it("does not hijack Up while an attachment is queued", async () => {
		const onEditLast = vi.fn();
		const { container } = render(() => (
			<TestClientProvider client={makeClient()}>
				<Composer roomId={ROOM} packs={[]} onEditLast={onEditLast} />
			</TestClientProvider>
		));
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("no file input");
		pickFiles(input, [new File(["a"], "pic.png", { type: "image/png" })]);
		await tick();
		const ta = getTextarea(container);
		ta.focus();
		const prevented = pressArrowUp(ta);
		expect(onEditLast).not.toHaveBeenCalled();
		expect(prevented).toBe(false);
	});
});
