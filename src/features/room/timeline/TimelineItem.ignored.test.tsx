import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "../../../test/mockClient";
import { TimelineItem } from "./TimelineItem";
import type { TimelineEvent } from "./timelineTypes";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
	return {
		eventId: "$ev",
		senderId: "@mallory:example.com",
		senderName: "Mallory",
		timestamp: 1000,
		type: "m.room.message",
		msgtype: "m.text",
		body: "spam you should not see",
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
		...overrides,
	};
}

function renderItem(
	event: TimelineEvent,
	isSenderIgnored: boolean,
	extra: { onForward?: () => void } = {},
) {
	const client = createMockClient();
	return render(() => (
		<TimelineItem
			event={event}
			showHeader={true}
			isOwnMessage={false}
			isSenderIgnored={isSenderIgnored}
			onForward={extra.onForward}
			onReact={() => {}}
			onVote={() => {}}
			onEndPoll={() => {}}
			onReply={() => {}}
			onJumpToReply={() => {}}
			onEdit={() => {}}
			onDelete={() => {}}
			client={client as unknown as MatrixClient}
			shortcodeLookup={new Map()}
			emoteLookup={new Map()}
			packs={[]}
		/>
	));
}

afterEach(() => {
	cleanup();
});

describe("TimelineItem ignored sender", () => {
	it("collapses the message to a placeholder, hiding the body", () => {
		renderItem(makeEvent(), true);
		expect(screen.queryByText("spam you should not see")).toBeNull();
		expect(
			screen.getByText(/Message hidden - Mallory is blocked/),
		).toBeTruthy();
		// No interactive affordances for the hidden message.
		expect(screen.queryByLabelText("Reply")).toBeNull();
		expect(screen.queryByLabelText("Forward")).toBeNull();
	});

	it("renders the message normally when the sender is not ignored", () => {
		renderItem(makeEvent(), false);
		expect(screen.getByText("spam you should not see")).toBeTruthy();
		expect(screen.queryByText(/Message hidden/)).toBeNull();
	});

	it("still renders state notices from an ignored sender", () => {
		renderItem(
			makeEvent({
				stateNotice: {
					text: "Mallory joined the room",
					icon: "info",
				} as never,
			}),
			true,
		);
		expect(screen.getByText("Mallory joined the room")).toBeTruthy();
		expect(screen.queryByText(/Message hidden/)).toBeNull();
	});
});

describe("TimelineItem Forward action", () => {
	it("renders the Forward toolbar button when wired and fires it", () => {
		const onForward = vi.fn();
		renderItem(makeEvent(), false, { onForward });
		const button = screen.getByLabelText("Forward");
		fireEvent.click(button);
		expect(onForward).toHaveBeenCalledTimes(1);
	});

	it("omits the Forward button when the prop is absent (non-forwardable)", () => {
		renderItem(makeEvent(), false);
		// Positive anchor first: sibling actions render, so the Forward
		// absence is the gating, not a broken toolbar.
		expect(screen.getByLabelText("Reply")).toBeTruthy();
		expect(screen.queryByLabelText("Forward")).toBeNull();
	});
});
