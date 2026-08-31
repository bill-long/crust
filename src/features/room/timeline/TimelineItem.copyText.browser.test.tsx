/**
 * Browser-mode tests for the hover toolbar's "Copy text" menu item. Runs
 * in headless Chromium because the Kobalte dropdown needs real pointer
 * events to open (the menu content portals onto document.body), and the
 * item's onSelect goes through afterMenuClose's deferred timer.
 */

import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/global.css";
import { createFailedImageUrls } from "../../../lib/imageFallback";
import { createMockClient } from "../../../test/mockClient";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { TimelineItem } from "./TimelineItem";
import type { TimelineEvent } from "./timelineTypes";

function renderItem(event: TimelineEvent, onCopyText?: (text: string) => void) {
	const client = createMockClient();
	return render(() => (
		<TimelineItem
			event={event}
			now={Date.now()}
			showHeader={true}
			isOwnMessage={false}
			onCopyText={onCopyText}
			onReact={() => {}}
			onVote={() => {}}
			onEndPoll={() => {}}
			onReply={() => {}}
			onJumpToReply={() => {}}
			onEdit={() => {}}
			onDelete={() => {}}
			onViewSource={() => {}}
			client={client as unknown as MatrixClient}
			shortcodeLookup={new Map()}
			emoteLookup={new Map()}
			packs={[]}
			brokenImages={createFailedImageUrls()}
			onOpenProfile={() => {}}
		/>
	));
}

async function openMoreMenu(container: HTMLElement): Promise<void> {
	const row = container.querySelector<HTMLElement>("[data-event-id]");
	if (!row) throw new Error("no timeline row");
	// The toolbar is pointer-events-none until the row is hovered.
	await userEvent.hover(row);
	const more = row.querySelector<HTMLButtonElement>(
		'button[aria-label="More"]',
	);
	if (!more) throw new Error("no More trigger");
	await userEvent.click(more);
}

function menuItem(label: string): HTMLElement | undefined {
	return [
		...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((el) => el.textContent?.trim() === label);
}

afterEach(() => cleanup());

describe("TimelineItem Copy text menu item", () => {
	it("copies a text message's body, reply fallback stripped", async () => {
		const onCopyText = vi.fn();
		const { container } = renderItem(
			makeTimelineEvent({ body: "> <@alice:hs> quoted\n\nactual reply" }),
			onCopyText,
		);
		await openMoreMenu(container);
		const item = menuItem("Copy text");
		if (!item) throw new Error("no Copy text item");
		await userEvent.click(item);
		// onSelect defers through afterMenuClose's timer.
		await vi.waitFor(() => {
			expect(onCopyText).toHaveBeenCalledWith("actual reply");
		});
	});

	it("copies a captioned image's caption", async () => {
		const onCopyText = vi.fn();
		const { container } = renderItem(
			makeTimelineEvent({
				msgtype: "m.image",
				body: "cat.png",
				mediaCaption: "look at this cat",
			}),
			onCopyText,
		);
		await openMoreMenu(container);
		const item = menuItem("Copy text");
		if (!item) throw new Error("no Copy text item");
		await userEvent.click(item);
		await vi.waitFor(() => {
			expect(onCopyText).toHaveBeenCalledWith("look at this cat");
		});
	});

	it("omits the item for uncaptioned media", async () => {
		const { container } = renderItem(
			makeTimelineEvent({
				msgtype: "m.file",
				body: "doc.pdf",
				mediaFilename: "doc.pdf",
			}),
			vi.fn(),
		);
		await openMoreMenu(container);
		// Positive anchor: the menu itself is open.
		expect(menuItem("View source")).toBeTruthy();
		expect(menuItem("Copy text")).toBeUndefined();
	});

	it("omits the item when the timeline wires no onCopyText", async () => {
		const { container } = renderItem(makeTimelineEvent(), undefined);
		await openMoreMenu(container);
		expect(menuItem("View source")).toBeTruthy();
		expect(menuItem("Copy text")).toBeUndefined();
	});
});
