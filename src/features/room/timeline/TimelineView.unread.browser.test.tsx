/**
 * Browser-mode tests for the unread divider and its jump affordance (#446).
 *
 * These belong in browser mode rather than jsdom for three reasons the
 * feature depends on: the divider's `IntersectionObserver`, virtua measuring
 * and recycling rows, and the divider's own height participating in layout.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import {
	installTimelineHarness,
	makeTimelineHarnessRef,
	TestClientProvider,
} from "../../../test/TimelineHarness";
import type { TimelineEvent } from "./useTimeline";

const harness = makeTimelineHarnessRef();

vi.mock("./useTimeline", () => ({
	useTimeline: installTimelineHarness(harness),
}));

vi.mock("../composer/Composer", () => ({
	Composer: () => null,
}));

const { TimelineView } = await import("./TimelineView");

const ROOM_ID = "!unread:example.com";
const ME = "@test:example.com";
const ALICE = "@alice:example.com";

function mkEvent(
	eventId: string,
	body: string,
	ts: number,
	senderId = ALICE,
): TimelineEvent {
	return {
		eventId,
		senderId,
		senderName: senderId === ME ? "Me" : "Alice",
		senderAvatarUrl: null,
		timestamp: ts,
		type: "m.room.message",
		msgtype: "m.text",
		body,
		format: null,
		formattedBody: null,
		mediaUrl: null,
		mediaWidth: null,
		mediaHeight: null,
		mediaFullUrl: null,
		mediaPosterUrl: null,
		mediaMimetype: null,
		mediaSize: null,
		mediaFilename: null,
		mediaCaption: null,
		mediaThumbnailUrl: null,
		mediaThumbnailFile: null,
		mediaThumbnailMimetype: null,
		mediaIsEncrypted: false,
		mediaEncryptedFile: null,
		isVoice: false,
		voiceDurationMs: null,
		voiceWaveform: null,
		isEncrypted: false,
		isDecryptionFailure: false,
		isEdited: false,
		replyToId: null,
		replyToSender: null,
		replyToBody: null,
		replyToThumbUrl: null,
		replyToThumbEncryptedFile: null,
		replyToThumbMimetype: null,
		reactions: {},
		myReactions: {},
		status: null,
		stateNotice: null,
		membershipTransition: null,
		poll: null,
		thread: null,
	};
}

/** Two messages a minute apart, which the 7-minute rule would group. */
function groupedPair(): TimelineEvent[] {
	return [
		mkEvent("$read", "read message", 1700000000000),
		mkEvent("$unread", "unread message", 1700000060000),
	];
}

function mountRoom(
	events: TimelineEvent[],
	readUpTo: string | null,
	readUpToTs = 0,
) {
	const room = createMockRoom(ROOM_ID, [], [{ userId: ALICE, name: "Alice" }]);
	if (readUpTo) room.__setReadUpTo(ME, readUpTo, readUpToTs);
	const rooms = new Map([[ROOM_ID, room]]);
	const client = createMockClient(rooms);

	harness.setRoomState(ROOM_ID, { events, loading: false });

	const wrapper = document.createElement("div");
	wrapper.style.cssText =
		"position:fixed;inset:0;width:800px;height:400px;background:#000;";
	document.body.appendChild(wrapper);
	render(
		() => (
			<TestClientProvider client={client}>
				<TimelineView roomId={ROOM_ID} />
			</TestClientProvider>
		),
		{ container: wrapper },
	);
	return { container: wrapper };
}

const findDivider = (root: ParentNode): HTMLElement | null =>
	[...root.querySelectorAll<HTMLElement>("div")].find(
		(el) => el.textContent === "New messages",
	) ?? null;

const findJumpButton = (root: ParentNode): HTMLElement | null =>
	root.querySelector<HTMLElement>(
		'button[aria-label="Jump to first unread message"]',
	);

afterEach(() => {
	cleanup();
	for (const el of document.querySelectorAll("div[style*='position:fixed']")) {
		el.remove();
	}
	harness.reset();
});

beforeEach(() => {
	harness.reset();
});

describe("unread divider (#446)", () => {
	it("draws the divider above the first row we have not read", async () => {
		const { container } = mountRoom(groupedPair(), "$read");
		await vi.waitFor(() => expect(findDivider(container)).toBeTruthy());

		const divider = findDivider(container);
		const unreadRow = container.querySelector<HTMLElement>(
			'[data-event-id="$unread"]',
		);
		if (!divider || !unreadRow)
			throw new Error("divider or unread row missing");
		// Above, not below: the divider is the boundary between the two.
		expect(
			divider.compareDocumentPosition(unreadRow) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("breaks message grouping so the first unread row keeps its header", async () => {
		// Same sender, one minute apart: without the break, the divider would
		// sit above a bare continuation line with no avatar or name.
		const { container } = mountRoom(groupedPair(), "$read");
		await vi.waitFor(() => expect(findDivider(container)).toBeTruthy());

		// The header renders the sender as a clickable name; a continuation
		// row only carries an sr-only label, so query the button specifically
		// or the assertion passes either way.
		const unreadRow = container.querySelector<HTMLElement>(
			'[data-event-id="$unread"]',
		);
		const nameButton = [
			...(unreadRow?.querySelectorAll<HTMLElement>("button") ?? []),
		].find((b) => b.textContent?.trim() === "Alice");
		expect(nameButton).toBeTruthy();

		// And the row above it, which we have read, is the group leader that
		// would otherwise have swallowed it.
		const readRow = container.querySelector<HTMLElement>(
			'[data-event-id="$read"]',
		);
		expect(
			[...(readRow?.querySelectorAll<HTMLElement>("button") ?? [])].find(
				(b) => b.textContent?.trim() === "Alice",
			),
		).toBeTruthy();
	});

	it("retires the jump button once the divider has been reached", async () => {
		// The virtualizer renders its rows a tick after mount, so the button
		// can be up for that tick - it retires as soon as the divider exists,
		// and must then stay gone rather than resurfacing on every scroll.
		const { container } = mountRoom(groupedPair(), "$read");
		await vi.waitFor(() => expect(findDivider(container)).toBeTruthy());
		await vi.waitFor(() => expect(findJumpButton(container)).toBeNull());

		await new Promise((r) => setTimeout(r, 150));
		expect(findJumpButton(container)).toBeNull();
	});

	it("offers the jump when the boundary is far above the viewport", async () => {
		// The dominant case: enough unread that the divider's row is nowhere
		// near the viewport, so the virtualizer never mounts it. Keying the
		// affordance off the divider being rendered misses exactly this.
		const events = [
			mkEvent("$read", "read message", 1700000000000),
			...Array.from({ length: 60 }, (_, i) =>
				mkEvent(`$unread${i}`, `unread message ${i}`, 1700000060000 + i * 1000),
			),
		];
		// Receipt sent before every loaded row: a real backlog, not a window
		// whose forward end was trimmed by deep scrollback.
		const { container } = mountRoom(events, "$read", 1);

		await vi.waitFor(() => expect(findJumpButton(container)).toBeTruthy());
		// And the divider itself is genuinely not rendered - otherwise this
		// would be testing the on-screen case by accident.
		expect(findDivider(container)).toBeNull();
	});

	it("leaves an emote's self-identifying line alone at the boundary", async () => {
		// The emote rule suppresses the header because "* Alice waves"
		// already names the sender; the unread break must not override it
		// and print the name twice.
		const emote = { ...mkEvent("$unread", "waves", 1700000060000) };
		emote.msgtype = "m.emote";
		const { container } = mountRoom(
			[mkEvent("$read", "read message", 1700000000000), emote],
			"$read",
		);
		await vi.waitFor(() => expect(findDivider(container)).toBeTruthy());

		const unreadRow = container.querySelector<HTMLElement>(
			'[data-event-id="$unread"]',
		);
		const nameButtons = [
			...(unreadRow?.querySelectorAll<HTMLElement>("button") ?? []),
		].filter((b) => b.textContent?.trim() === "Alice");
		expect(nameButtons).toHaveLength(0);
	});

	it("draws no divider in a room we have read to the end", async () => {
		const { container } = mountRoom(groupedPair(), "$unread");
		await new Promise((r) => setTimeout(r, 150));
		expect(findDivider(container)).toBeNull();
		expect(findJumpButton(container)).toBeNull();
	});
});
