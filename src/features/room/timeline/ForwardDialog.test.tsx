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
		membership: "join",
		isEncrypted: false,
		isDirect: false,
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
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function setup(seed: RoomSummary[]) {
	const client = createMockClient();
	const onClose = vi.fn();
	render(() => (
		<Wrapper client={client} seed={seed}>
			<ForwardDialog
				target={() => makeTimelineEvent()}
				getSourceEvent={() => sourceEvent}
				onClose={onClose}
			/>
		</Wrapper>
	));
	return { client, onClose };
}

afterEach(() => {
	cleanup();
	clearNotices();
});

beforeEach(() => {
	// jsdom doesn't implement scrollIntoView (the Picker scrolls the
	// highlighted option into view on mount/filter changes).
	Element.prototype.scrollIntoView = vi.fn();
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
});
