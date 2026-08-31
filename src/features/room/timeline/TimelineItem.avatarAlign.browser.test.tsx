/**
 * Browser-mode test for the message-group avatar's vertical alignment.
 * Runs in headless Chromium because the invariant is a laid-out one: the
 * timeline row is a flex container, so an avatar without `self-start`
 * stretches to the full group height and a `<button>` centres its own
 * content - parking the avatar halfway down a long message. Only a real
 * layout engine can see that.
 */

import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it } from "vitest";
import "../../../styles/global.css";
import { createFailedImageUrls } from "../../../lib/imageFallback";
import { createMockClient } from "../../../test/mockClient";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import { TimelineItem } from "./TimelineItem";

/** Long enough to wrap to several lines at any test viewport width. */
const LONG_BODY = "wrapping body text. ".repeat(40);

/** The sender name `makeTimelineEvent` defaults to. */
const SENDER = "Mallory";

function renderLongMessage(): HTMLElement {
	const client = createMockClient();
	const { container } = render(() => (
		<TimelineItem
			event={makeTimelineEvent({ body: LONG_BODY })}
			now={Date.now()}
			showHeader={true}
			isOwnMessage={false}
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
	return container;
}

afterEach(() => cleanup());

describe("TimelineItem avatar alignment", () => {
	it("keeps the avatar at the top of a multi-line message group", () => {
		const container = renderLongMessage();

		const avatar = container.querySelector<HTMLButtonElement>(
			'button[aria-label^="View profile of"]',
		);
		// By its text, not by a utility class: HoverToolbar renders earlier in
		// the row, so a class-based query would silently start matching a
		// toolbar button and leave the assertions below passing vacuously.
		const senderName = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((b) => b.textContent?.trim() === SENDER);
		if (!avatar || !senderName) throw new Error("no avatar / header button");

		const avatarBox = avatar.getBoundingClientRect();
		const headerBox = senderName.getBoundingClientRect();
		const rowBox = (
			avatar.parentElement as HTMLElement
		).getBoundingClientRect();

		// The group is genuinely taller than one line, or this proves nothing.
		expect(rowBox.height).toBeGreaterThan(headerBox.height * 3);

		// The button hugs the avatar it wraps instead of stretching to the
		// group: a stretched one still paints the avatar at its own size, so
		// comparing the two boxes is what catches the regression.
		const glyphBox = (
			avatar.firstElementChild as HTMLElement
		).getBoundingClientRect();
		expect(avatarBox.height).toBeCloseTo(glyphBox.height, 0);

		// And it sits beside the sender header rather than mid-message.
		expect(avatarBox.top).toBeLessThan(headerBox.bottom);
	});
});
