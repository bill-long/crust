import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../../client/client";
import { ClientContext } from "../../../client/client";
import {
	createSummariesStore,
	type RoomSummary,
	type SummariesStore,
} from "../../../client/summaries";
import { clearNotices, notices } from "../../../stores/notices";
import { createMockClient } from "../../../test/mockClient";
import { stubViewport } from "../../../test/stubViewport";
import { ForwardDialog } from "./ForwardDialog";
import type { TimelineEvent } from "./timelineTypes";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function makeRoomSummary(
	roomId: string,
	name: string,
	overrides: Partial<RoomSummary> = {},
): RoomSummary {
	return {
		roomId,
		name,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
		isFavourite: false,
		isLowPriority: false,
		spaceOrder: null,
		isMuted: false,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		dmUserId: null,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...overrides,
	};
}

function makeTimelineEvent(): TimelineEvent {
	return {
		eventId: "$ev",
		senderId: "@alice:example.com",
		senderName: "Alice",
		senderAvatarUrl: null,
		timestamp: 1000,
		type: "m.room.message",
		msgtype: "m.text",
		body: "hello world",
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

const sourceEvent = {
	getContent: () => ({ msgtype: "m.text", body: "hello world" }),
} as unknown as MatrixEvent;

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
	seed: RoomSummary[];
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const store = createSummariesStore(props.client as unknown as MatrixClient);
	for (const s of props.seed) store.setSummaries(s.roomId, s);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: store.summaries as unknown as SummariesStore,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
					backupOnServer: () => false,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					crossSigningStatus: () => undefined,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined: vi.fn(),
				optimisticallyMarkKnocked: vi.fn(),
				optimisticallyMarkLeft: vi.fn(),
				optimisticallySetMarkedUnread: vi.fn(),
				optimisticallySetRoomTag: vi.fn(),
				optimisticallySetSpaceOrder: vi.fn(),
				forgetRoomLocally: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function setup(
	seed: RoomSummary[],
	options?: {
		target?: () => TimelineEvent | null;
		getSourceEvent?: () => MatrixEvent | undefined;
	},
) {
	const client = createMockClient();
	const onClose = vi.fn();
	render(() => (
		<Wrapper client={client} seed={seed}>
			<ForwardDialog
				target={options?.target ?? (() => makeTimelineEvent())}
				getSourceEvent={options?.getSourceEvent ?? (() => sourceEvent)}
				onClose={onClose}
			/>
		</Wrapper>
	));
	return { client, onClose };
}

// The room list is windowed (VirtualList); without a stubbed viewport the
// picker renders at clientHeight 0 and mounts only the first few rows.
let restoreViewport: () => void;
beforeEach(() => {
	restoreViewport = stubViewport(216);
});

afterEach(() => {
	restoreViewport();
	cleanup();
	clearNotices();
});

describe("ForwardDialog", () => {
	it("lists joined rooms and forwards on selection", async () => {
		const { client, onClose } = setup([
			makeRoomSummary("!a:example.com", "alpha"),
			makeRoomSummary("!b:example.com", "beta"),
			// Spaces are never forward targets.
			makeRoomSummary("!space:example.com", "my space", { isSpace: true }),
			// Invited rooms are not joined yet.
			makeRoomSummary("!inv:example.com", "invited", {
				membership: "invite",
			}),
		]);
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		expect(screen.getByText("beta")).toBeTruthy();
		expect(screen.queryByText("my space")).toBeNull();
		expect(screen.queryByText("invited")).toBeNull();

		fireEvent.mouseDown(screen.getByText("alpha"));
		await waitFor(() =>
			expect(client.sendMessage).toHaveBeenCalledWith("!a:example.com", null, {
				msgtype: "m.text",
				body: "hello world",
			}),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(notices().some((n) => n.message.includes("Forwarded"))).toBe(true);
	});

	it("filters the room list by the search query", async () => {
		setup([
			makeRoomSummary("!a:example.com", "alpha"),
			makeRoomSummary("!b:example.com", "beta"),
		]);
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.input(screen.getByPlaceholderText("Search rooms"), {
			target: { value: "bet" },
		});
		await waitFor(() => expect(screen.queryByText("alpha")).toBeNull());
		expect(screen.getByText("beta")).toBeTruthy();
	});

	it("surfaces a send failure inline and keeps the dialog open", async () => {
		const { client, onClose } = setup([
			makeRoomSummary("!a:example.com", "alpha"),
		]);
		client.sendMessage.mockRejectedValue(new Error("M_FORBIDDEN: nope"));
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.mouseDown(screen.getByText("alpha"));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("nope"),
		);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("shows the curated fallback for browser-jargon errors", async () => {
		const { client } = setup([makeRoomSummary("!a:example.com", "alpha")]);
		client.sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.mouseDown(screen.getByText("alpha"));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Couldn't forward the message. Please try again.",
			),
		);
	});

	it("reports a missing source event instead of forwarding", async () => {
		setup([makeRoomSummary("!a:example.com", "alpha")], {
			getSourceEvent: () => undefined,
		});
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.mouseDown(screen.getByText("alpha"));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Couldn't find the original message. Try again.",
			),
		);
	});

	it("falls back to 'Attachment' for a bodiless message and badges DMs", async () => {
		setup([makeRoomSummary("!dm:example.com", "carol", { isDirect: true })], {
			target: () => ({ ...makeTimelineEvent(), body: "" }),
		});
		await waitFor(() => expect(screen.getByText("Attachment")).toBeTruthy());
		expect(screen.getByText("DM")).toBeTruthy();
	});

	it("reflects listbox presence in aria-expanded", async () => {
		setup([makeRoomSummary("!a:example.com", "alpha")]);
		const input = screen.getByPlaceholderText("Search rooms");
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		expect(input.getAttribute("aria-expanded")).toBe("true");
		// No matches: the listbox unmounts, and the combobox must say so
		// (Composer's pickerExpanded sibling idiom, not a hard-coded true).
		fireEvent.input(input, { target: { value: "zzz" } });
		await waitFor(() => expect(input.getAttribute("aria-expanded")).toBeNull());
	});

	it("focuses the search input on open", async () => {
		setup([makeRoomSummary("!a:example.com", "alpha")]);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByPlaceholderText("Search rooms"),
			),
		);
	});

	it("restores focus to the pre-open element on close", async () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		trigger.focus();
		try {
			const [target, setTarget] = createSignal<TimelineEvent | null>(
				makeTimelineEvent(),
			);
			setup([makeRoomSummary("!a:example.com", "alpha")], { target });
			// Opening captured the trigger as previousFocus and moved focus
			// into the dialog.
			await waitFor(() =>
				expect(document.activeElement).toBe(
					screen.getByPlaceholderText("Search rooms"),
				),
			);
			setTarget(null);
			await waitFor(() => expect(document.activeElement).toBe(trigger));
		} finally {
			trigger.remove();
		}
	});

	it("closes via Cancel, backdrop click, and Escape", async () => {
		// Cancel
		const first = setup([makeRoomSummary("!a:example.com", "alpha")]);
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(first.onClose).toHaveBeenCalledTimes(1);
		cleanup();

		// Backdrop
		const second = setup([makeRoomSummary("!a:example.com", "alpha")]);
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.click(screen.getByRole("dialog"));
		expect(second.onClose).toHaveBeenCalledTimes(1);
		cleanup();

		// Escape (from the Cancel button, i.e. outside the picker input)
		const third = setup([makeRoomSummary("!a:example.com", "alpha")]);
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(third.onClose).toHaveBeenCalledTimes(1);
	});

	it("blocks every close path while a forward is in flight", async () => {
		const { client, onClose } = setup([
			makeRoomSummary("!a:example.com", "alpha"),
		]);
		let resolveSend!: (v: { event_id: string }) => void;
		client.sendMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSend = resolve;
				}),
		);
		await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
		fireEvent.mouseDown(screen.getByText("alpha"));
		await waitFor(() => expect(client.sendMessage).toHaveBeenCalled());

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		fireEvent.click(screen.getByRole("dialog"));
		expect(onClose).not.toHaveBeenCalled();

		resolveSend({ event_id: "$done" });
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});
});
