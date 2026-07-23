/**
 * Browser-mode tests for the composer's "+" menu (the Discord-style left
 * trigger that holds attach/poll/event/voice). Runs in headless Chromium
 * because the Kobalte dropdown needs real pointer events to open, and the
 * portaled menu content renders on document.body.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";
import { isVoiceRecordingSupported } from "./media/voiceRecorder";

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

function makeClient() {
	const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
	rooms.set(
		ROOM,
		createMockRoom(ROOM, [], [{ userId: "@test:example.com", name: "Test" }]),
	);
	return createMockClient(rooms);
}

function renderComposer() {
	const client = makeClient();
	return render(() => (
		<TestClientProvider client={client}>
			<Composer roomId={ROOM} packs={[]} />
		</TestClientProvider>
	));
}

function menuItems(): string[] {
	return [...document.body.querySelectorAll('[role="menuitem"]')].map(
		(el) => el.textContent?.trim() ?? "",
	);
}

afterEach(() => cleanup());

describe("Composer plus menu", () => {
	it("opens on click with the composer actions as items", async () => {
		const { getByLabelText } = renderComposer();
		expect(menuItems()).toEqual([]);
		await userEvent.click(getByLabelText("Message actions"));
		const items = menuItems();
		expect(items).toContain("Attach file");
		expect(items).toContain("Create poll");
		expect(items).toContain("Create event");
		// The voice item is feature-detected, same gate as the composer's.
		expect(items.includes("Record voice message")).toBe(
			isVoiceRecordingSupported(),
		);
	});

	it("forwards 'Attach file' to the hidden file input", async () => {
		const { container, getByLabelText } = renderComposer();
		const input = container.querySelector<HTMLInputElement>(
			"input[data-composer-file-input]",
		);
		if (!input) throw new Error("no file input");
		// A real .click() would open the OS file dialog; observe it instead.
		const clicked = vi.fn();
		input.addEventListener("click", (e) => {
			e.preventDefault();
			clicked();
		});
		await userEvent.click(getByLabelText("Message actions"));
		const item = [...document.body.querySelectorAll('[role="menuitem"]')].find(
			(el) => el.textContent?.trim() === "Attach file",
		);
		if (!item) throw new Error("no attach item");
		await userEvent.click(item);
		expect(clicked).toHaveBeenCalledTimes(1);
	});

	it("closes the emoji picker when the menu opens (no double-popover)", async () => {
		const { container, getByLabelText } = renderComposer();
		(getByLabelText("Open emoji picker") as HTMLButtonElement).click();
		expect(container.querySelector('[aria-label="Emoji picker"]')).toBeTruthy();
		await userEvent.click(getByLabelText("Message actions"));
		expect(container.querySelector('[aria-label="Emoji picker"]')).toBeNull();
	});

	it("focuses the trigger when Escape closes a menu opened over the emoji picker", async () => {
		const { getByLabelText } = renderComposer();
		// Focus starts inside the emoji picker (its search input autofocuses),
		// which onOpen then unmounts - Kobalte's own restore would target the
		// detached input and silently drop focus to <body>.
		(getByLabelText("Open emoji picker") as HTMLButtonElement).click();
		const trigger = getByLabelText("Message actions");
		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() => {
			expect(menuItems()).toEqual([]);
			expect(document.activeElement).toBe(trigger);
		});
	});

	it("does not steal focus when the menu is dismissed by clicking the textarea", async () => {
		const { container, getByLabelText } = renderComposer();
		const trigger = getByLabelText("Message actions");
		await userEvent.click(trigger);
		expect(menuItems()).not.toEqual([]);
		// Dismiss by clicking a focusable element: focus has legitimately
		// moved on, so the close must NOT yank it back to the trigger (the
		// onCloseAutoFocus handler defers to Kobalte's pre-applied
		// preventDefault in this case).
		const textarea = container.querySelector("textarea");
		if (!textarea) throw new Error("no textarea");
		await userEvent.click(textarea);
		await vi.waitFor(() => {
			expect(menuItems()).toEqual([]);
			expect(document.activeElement).toBe(textarea);
		});
	});

	it("returns focus to the textarea after closing a poll dialog opened from the menu", async () => {
		const { container, getByLabelText } = renderComposer();
		await userEvent.click(getByLabelText("Message actions"));
		const item = [...document.body.querySelectorAll('[role="menuitem"]')].find(
			(el) => el.textContent?.trim() === "Create poll",
		);
		if (!item) throw new Error("no poll item");
		await userEvent.click(item);
		// The dialog is open with focus inside it (the question input).
		const dialog = document.body.querySelector('[role="dialog"]');
		if (!dialog) throw new Error("poll dialog did not open");
		await vi.waitFor(() => {
			expect(dialog.contains(document.activeElement)).toBe(true);
		});
		// Escape closes it; focus must land back on the composer textarea,
		// not on <body> (the menu item that opened it no longer exists).
		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() => {
			expect(document.body.querySelector('[role="dialog"]')).toBeNull();
			expect(document.activeElement).toBe(container.querySelector("textarea"));
		});
	});
});
