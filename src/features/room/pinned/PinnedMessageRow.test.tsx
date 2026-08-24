import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type {
	EventTimelineSet,
	MatrixClient,
	MatrixEvent,
	Room,
} from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedMessageRow, type ResolvedPinnedEvent } from "./PinnedMessageRow";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// The row under test owns resolution + jump wiring; body rendering has
// its own suite.
vi.mock("../../emoji/MessageBody", () => ({
	MessageBody: (props: { body: string }) => <span>{props.body}</span>,
}));

afterEach(() => {
	cleanup();
});

interface RawEvent {
	type: string;
	event_id: string;
	room_id: string;
	sender: string;
	origin_server_ts: number;
	content: Record<string, unknown>;
}

function rawMessage(
	eventId: string,
	content: Record<string, unknown>,
): RawEvent {
	return {
		type: "m.room.message",
		event_id: eventId,
		room_id: "!r:hs",
		sender: "@alice:hs",
		origin_server_ts: 1000,
		content,
	};
}

function makeRoom(overrides?: Partial<Room>): Room {
	return {
		roomId: "!r:hs",
		findEventById: () => undefined,
		getMember: () => ({ name: "Alice" }),
		getUnfilteredTimelineSet: () => ({}),
		...overrides,
	} as unknown as Room;
}

/** Cached-event mock with the decryption-watcher surface the row reads. */
function cachedEvent(body: string): MatrixEvent {
	return {
		getId: () => "$pinned:hs",
		getSender: () => "@alice:hs",
		getContent: () => ({ msgtype: "m.text", body }),
		getTs: () => 1000,
		isRelation: () => false,
		isBeingDecrypted: () => false,
		shouldAttemptDecryption: () => false,
		isDecryptionFailure: () => false,
	} as unknown as MatrixEvent;
}

function makeClient(overrides?: Partial<MatrixClient>): MatrixClient {
	return {
		// Resolves without caching anything - the SDK's behavior for a
		// thread reply on a room timeline set (warn + null, no throw).
		getEventTimeline: vi.fn().mockResolvedValue(null),
		fetchRoomEvent: vi.fn().mockRejectedValue(new Error("not found")),
		decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as MatrixClient;
}

function renderRow(
	client: MatrixClient,
	room: Room,
	onJump = vi.fn(),
	over?: {
		timelineTick?: () => number;
		resolveCache?: Map<string, ResolvedPinnedEvent>;
		contextTimelineSet?: EventTimelineSet | null;
	},
) {
	render(() => (
		<PinnedMessageRow
			client={client}
			room={room}
			eventId="$pinned:hs"
			timelineTick={over?.timelineTick ?? (() => 0)}
			resolveCache={over?.resolveCache ?? new Map()}
			contextTimelineSet={over?.contextTimelineSet ?? null}
			canPin={false}
			shortcodeLookup={new Map()}
			tabIndex={0}
			onJump={onJump}
			onUnpin={() => {}}
		/>
	));
	return onJump;
}

describe("PinnedMessageRow", () => {
	it("falls back to a standalone fetch for a pinned thread reply and jumps with its root", async () => {
		const client = makeClient({
			fetchRoomEvent: vi.fn().mockResolvedValue(
				rawMessage("$pinned:hs", {
					msgtype: "m.text",
					body: "reply in a thread",
					"m.relates_to": {
						rel_type: "m.thread",
						event_id: "$root:hs",
						is_falling_back: true,
						"m.in_reply_to": { event_id: "$root:hs" },
					},
				}),
			) as MatrixClient["fetchRoomEvent"],
		});
		const onJump = renderRow(client, makeRoom());
		expect(await screen.findByText("reply in a thread")).toBeTruthy();
		fireEvent.click(screen.getByText("Jump to"));
		expect(onJump).toHaveBeenCalledWith("$root:hs");
	});

	it("still reaches the standalone fetch when getEventTimeline throws (#485)", async () => {
		// The real SDK throws synchronously when timelineSupport is off (the
		// #485 misconfiguration) - and can reject for other reasons too. The
		// row must not let that swallow the standalone fallback.
		const getEventTimeline = vi
			.fn()
			.mockRejectedValue(new Error("timeline support is disabled."));
		const client = makeClient({
			getEventTimeline: getEventTimeline as MatrixClient["getEventTimeline"],
			fetchRoomEvent: vi.fn().mockResolvedValue(
				rawMessage("$pinned:hs", {
					msgtype: "m.text",
					body: "resolved despite the throw",
				}),
			) as MatrixClient["fetchRoomEvent"],
		});
		const privateSet = {
			findEventById: () => undefined,
		} as unknown as EventTimelineSet;
		renderRow(client, makeRoom(), undefined, {
			contextTimelineSet: privateSet,
		});
		expect(await screen.findByText("resolved despite the throw")).toBeTruthy();
		// The /context fetch targets the panel's PRIVATE set, never the
		// room's own unfiltered set (whose emissions would reach
		// useTimeline's backfill-reload guard and grow the set forever).
		expect(getEventTimeline).toHaveBeenCalledWith(privateSet, "$pinned:hs");
	});

	it("re-resolves an open row when the panel's timeline tick fires (#485)", async () => {
		// Back-pagination while the panel is open used to leave the row on
		// "(message unavailable)" until close/reopen - the sync resolve was a
		// memo over non-reactive SDK state. The tick is panel-owned (one
		// filtered room subscription in usePinnedEvents, not one unfiltered
		// listener per row).
		const [tick, setTick] = createSignal(0);
		let cached: MatrixEvent | undefined;
		const room = makeRoom({
			findEventById: (() => cached) as Room["findEventById"],
		});
		renderRow(makeClient(), room, undefined, { timelineTick: tick });
		expect(await screen.findByText("(message unavailable)")).toBeTruthy();
		// The event lands via back-pagination; usePinnedEvents bumps the tick.
		cached = cachedEvent("arrived late");
		setTick(1);
		expect(await screen.findByText("arrived late")).toBeTruthy();
	});

	it("serves a cached resolution without any network calls on reopen", async () => {
		const client = makeClient();
		const cache = new Map<string, ResolvedPinnedEvent>();
		cache.set("$pinned:hs", {
			event: cachedEvent("from the cache"),
			sender: "@alice:hs",
			senderName: "Alice",
			timestamp: 1000,
			body: "from the cache",
			format: null,
			formattedBody: null,
			msgtype: "m.text",
		});
		renderRow(client, makeRoom(), undefined, { resolveCache: cache });
		expect(await screen.findByText("from the cache")).toBeTruthy();
		expect(client.getEventTimeline).not.toHaveBeenCalled();
		expect(client.fetchRoomEvent).not.toHaveBeenCalled();
	});

	it("re-arms after a failed decryption and updates once the key arrives (#485)", async () => {
		// A UISI pin has clearEvent set, so shouldAttemptDecryption() is
		// false - the watcher must still attach via isDecryptionFailure()
		// and survive an intermediate failed retry, or the row keeps the
		// undecryptable fallback until close/reopen.
		let failed = true;
		const handlers = new Set<() => void>();
		const onceSpy = vi.fn((_e: unknown, cb: () => void) => {
			handlers.add(cb);
		});
		const ev = {
			getId: () => "$pinned:hs",
			getSender: () => "@alice:hs",
			getContent: () =>
				failed
					? { msgtype: "m.bad.encrypted", body: "" }
					: { msgtype: "m.text", body: "decrypted at last" },
			getTs: () => 1000,
			isRelation: () => false,
			isBeingDecrypted: () => false,
			shouldAttemptDecryption: () => false,
			isDecryptionFailure: () => failed,
			once: onceSpy,
			off: vi.fn((_e: unknown, cb: () => void) => {
				handlers.delete(cb);
			}),
		} as unknown as MatrixEvent;
		renderRow(makeClient(), makeRoom({ findEventById: () => ev }));
		await screen.findByRole("article");
		expect(onceSpy).toHaveBeenCalledTimes(1);
		// A retry fires Decrypted but STILL fails: the watcher re-arms.
		for (const cb of [...handlers]) {
			handlers.delete(cb);
			cb();
		}
		await new Promise((r) => setTimeout(r, 0));
		expect(onceSpy).toHaveBeenCalledTimes(2);
		// The key arrives; the successful retry fires Decrypted again.
		failed = false;
		for (const cb of [...handlers]) cb();
		expect(await screen.findByText("decrypted at last")).toBeTruthy();
	});

	it("jumps without a root for a cached main-timeline event", async () => {
		const cached = cachedEvent("plain pin");
		const onJump = renderRow(
			makeClient(),
			makeRoom({ findEventById: () => cached }),
		);
		expect(await screen.findByText("plain pin")).toBeTruthy();
		fireEvent.click(screen.getByText("Jump to"));
		expect(onJump).toHaveBeenCalledWith(undefined);
	});

	it("shows the unavailable state when both resolution paths fail", async () => {
		renderRow(makeClient(), makeRoom());
		expect(await screen.findByText("(message unavailable)")).toBeTruthy();
	});

	it("Enter on the focused row jumps with the row-resolved thread root", async () => {
		const client = makeClient({
			fetchRoomEvent: vi.fn().mockResolvedValue(
				rawMessage("$pinned:hs", {
					msgtype: "m.text",
					body: "reply in a thread",
					"m.relates_to": { rel_type: "m.thread", event_id: "$root:hs" },
				}),
			) as MatrixClient["fetchRoomEvent"],
		});
		const onJump = renderRow(client, makeRoom());
		await screen.findByText("reply in a thread");
		fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
		expect(onJump).toHaveBeenCalledWith("$root:hs");
	});

	it("Enter on an unavailable row is a no-op (no doomed main-timeline jump)", async () => {
		const onJump = renderRow(makeClient(), makeRoom());
		await screen.findByText("(message unavailable)");
		fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
		expect(onJump).not.toHaveBeenCalled();
	});
});
