import type { MatrixClient, MatrixEvent, RoomMember } from "matrix-js-sdk";
import { ReceiptType, RoomEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredAt } from "./testAssertions";
import type { TimelineEvent } from "./timelineTypes";
import { useReadReceipts } from "./useReadReceipts";

const ROOM_A = "!a:example.com";
const ROOM_B = "!b:example.com";
const ME = "@me:example.com";

interface MemberState {
	userId: string;
	name?: string;
	readUpTo: string | null;
}

interface MountOptions {
	roomId?: string;
	rooms?: Map<string, MemberState[]>;
	events?: TimelineEvent[];
	windowEvents?: MatrixEvent[];
	atBottom?: boolean;
	canLoadNewer?: boolean;
	thread?: { threadId: string };
	sourceEvents?: MatrixEvent[];
	sendReadReceipt?: ReturnType<typeof vi.fn>;
}

let rafCallbacks: FrameRequestCallback[];

beforeEach(() => {
	rafCallbacks = [];
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function row(
	eventId: string,
	stateNotice: TimelineEvent["stateNotice"] = null,
) {
	return { eventId, stateNotice } as TimelineEvent;
}

function raw(eventId: string | undefined): MatrixEvent {
	return { getId: () => eventId } as MatrixEvent;
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(options: MountOptions = {}) {
	const rooms = options.rooms ?? new Map([[ROOM_A, []]]);
	const receiptListeners = new Set<
		(event: unknown, room: { roomId: string }) => void
	>();
	const sendReadReceipt =
		options.sendReadReceipt ?? vi.fn(() => Promise.resolve());
	const client = {
		getRoom: vi.fn((id: string) => {
			const members = rooms.get(id);
			if (!members) return null;
			return {
				getMembers: () => members as unknown as RoomMember[],
				getEventReadUpTo: (userId: string) =>
					members.find((member) => member.userId === userId)?.readUpTo ?? null,
			};
		}),
		on: vi.fn(
			(
				_event: string,
				listener: (event: unknown, room: { roomId: string }) => void,
			) => {
				receiptListeners.add(listener);
			},
		),
		off: vi.fn(
			(
				_event: string,
				listener: (event: unknown, room: { roomId: string }) => void,
			) => {
				receiptListeners.delete(listener);
			},
		),
		sendReadReceipt,
	} as unknown as MatrixClient;

	const [roomId, setRoomId] = createSignal(options.roomId ?? ROOM_A);
	const [thread, setThread] = createSignal<{ threadId: string } | undefined>(
		options.thread,
	);
	const [atBottom, setAtBottom] = createSignal(options.atBottom ?? false);
	const [canLoadNewer, setCanLoadNewer] = createSignal(
		options.canLoadNewer ?? false,
	);
	const [events, setEventStore] = createStore<TimelineEvent[]>([
		...(options.events ?? []),
	]);
	const setEvents = (next: TimelineEvent[]): void =>
		setEventStore(reconcile(next));
	const [windowEvents, setWindowEvents] = createSignal(
		options.windowEvents ??
			options.events?.map((event) => raw(event.eventId)) ??
			[],
	);
	const sourceEvents = new Map(
		(options.sourceEvents ?? []).map((event) => [event.getId(), event]),
	);

	const root = createRoot((dispose) => ({
		dispose,
		result: useReadReceipts(client, roomId, thread, {
			events,
			getWindowEvents: windowEvents,
			getSourceEvent: (eventId) => sourceEvents.get(eventId),
			atBottom,
			canLoadNewer,
			myUserId: ME,
		}),
	}));

	return {
		...root,
		client,
		rooms,
		sendReadReceipt,
		setRoomId,
		setThread,
		setAtBottom,
		setCanLoadNewer,
		setEvents,
		setWindowEvents,
		addSourceEvent: (event: MatrixEvent) => {
			sourceEvents.set(event.getId(), event);
		},
		emitReceipt: (forRoom = ROOM_A) => {
			for (const listener of receiptListeners) {
				listener({}, { roomId: forRoom });
			}
		},
	};
}

describe("useReadReceipts receipt projection", () => {
	it("returns an empty null-prototype map when the room is unavailable", () => {
		const handle = mount({ rooms: new Map() });

		const receipts = handle.result.receipts();
		expect(Object.keys(receipts)).toEqual([]);
		expect(Object.getPrototypeOf(receipts)).toBeNull();
		handle.dispose();
	});

	it("resolves hidden targets, excludes state notices and self, and sorts users", () => {
		const members: MemberState[] = [
			{ userId: ME, name: "Me", readUpTo: "$last" },
			{ userId: "@charlie:example.com", name: "Charlie", readUpTo: "$hidden" },
			{ userId: "@alice:example.com", readUpTo: "$shown" },
			{ userId: "@bob:example.com", name: "Bob", readUpTo: null },
			{ userId: "@lost:example.com", name: "Lost", readUpTo: "$outside" },
			{ userId: "@state:example.com", name: "State", readUpTo: "$state" },
		];
		const handle = mount({
			rooms: new Map([[ROOM_A, members]]),
			events: [
				row("$first"),
				row("$state", {} as TimelineEvent["stateNotice"]),
				row("$shown"),
				row("$last"),
			],
			windowEvents: [
				raw("$first"),
				raw("$state"),
				raw("$shown"),
				raw(undefined),
				raw("$hidden"),
				raw("$last"),
			],
		});

		expect(handle.result.receipts()).toEqual({
			$first: [{ userId: "@state:example.com", displayName: "State" }],
			$shown: [
				{ userId: "@alice:example.com", displayName: "@alice:example.com" },
				{ userId: "@charlie:example.com", displayName: "Charlie" },
			],
		});
		handle.dispose();
	});

	it("refreshes only for receipt events in the active room", () => {
		const members = [
			{ userId: "@alice:example.com", name: "Alice", readUpTo: "$first" },
		];
		const handle = mount({
			rooms: new Map([[ROOM_A, members]]),
			events: [row("$first"), row("$second")],
		});
		expect(handle.result.receipts().$first).toHaveLength(1);

		requiredAt(members, 0, "room member").readUpTo = "$second";
		handle.emitReceipt(ROOM_B);
		expect(handle.result.receipts().$first).toHaveLength(1);
		expect(handle.result.receipts().$second).toBeUndefined();

		handle.emitReceipt();
		expect(handle.result.receipts().$first).toBeUndefined();
		expect(handle.result.receipts().$second).toHaveLength(1);
		handle.dispose();
	});

	it("moves projection to the newly selected room", () => {
		const handle = mount({
			rooms: new Map([
				[
					ROOM_A,
					[{ userId: "@alice:example.com", name: "Alice", readUpTo: "$one" }],
				],
				[
					ROOM_B,
					[{ userId: "@bob:example.com", name: "Bob", readUpTo: "$two" }],
				],
			]),
			events: [row("$one")],
		});
		expect(handle.result.receipts().$one?.[0]?.userId).toBe(
			"@alice:example.com",
		);

		handle.setEvents([row("$two")]);
		handle.setWindowEvents([raw("$two")]);
		handle.setRoomId(ROOM_B);
		expect(handle.result.receipts().$two?.[0]?.userId).toBe("@bob:example.com");
		handle.dispose();
	});

	it("removes its receipt listener on cleanup", () => {
		const handle = mount();
		expect(handle.client.on).toHaveBeenCalledWith(
			RoomEvent.Receipt,
			expect.any(Function),
		);

		handle.dispose();
		expect(handle.client.off).toHaveBeenCalledWith(
			RoomEvent.Receipt,
			expect.any(Function),
		);
	});
});

describe("useReadReceipts sending", () => {
	it("sends an unthreaded receipt when the main timeline reaches bottom", async () => {
		const source = raw("$latest");
		const handle = mount({ events: [row("$latest")], sourceEvents: [source] });

		handle.setAtBottom(true);
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(1);
		expect(handle.sendReadReceipt).toHaveBeenCalledWith(
			source,
			ReceiptType.Read,
			true,
		);
		await flushPromises();

		handle.setAtBottom(false);
		handle.setAtBottom(true);
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("sends a threaded receipt inside a thread panel", () => {
		const source = raw("$latest");
		const handle = mount({
			events: [row("$latest")],
			sourceEvents: [source],
			thread: { threadId: "$root" },
		});

		handle.setAtBottom(true);
		expect(handle.sendReadReceipt).toHaveBeenCalledWith(
			source,
			ReceiptType.Read,
			false,
		);
		handle.dispose();
	});

	it("waits until forward pagination reaches live", () => {
		const source = raw("$latest");
		const handle = mount({
			events: [row("$latest")],
			sourceEvents: [source],
			atBottom: true,
			canLoadNewer: true,
		});
		expect(handle.sendReadReceipt).not.toHaveBeenCalled();

		handle.setCanLoadNewer(false);
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("sends for a new final event even when the row count is unchanged", async () => {
		const first = raw("$first");
		const second = raw("$second");
		const handle = mount({
			events: [row("$first")],
			sourceEvents: [first, second],
		});
		handle.setAtBottom(true);
		await flushPromises();

		handle.setEvents([row("$second")]);
		expect(handle.sendReadReceipt).toHaveBeenLastCalledWith(
			second,
			ReceiptType.Read,
			true,
		);
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(2);
		handle.dispose();
	});

	it("skips empty timelines, local echoes, and events missing their SDK source", () => {
		const handle = mount({ atBottom: true });
		expect(handle.sendReadReceipt).not.toHaveBeenCalled();

		handle.setEvents([row("~local")]);
		handle.addSourceEvent(raw("~local"));
		handle.setEvents([row("$missing")]);
		expect(handle.sendReadReceipt).not.toHaveBeenCalled();
		handle.dispose();
	});

	it("retries a failed best-effort receipt on the next trigger", async () => {
		const sendReadReceipt = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(undefined);
		const handle = mount({
			events: [row("$latest")],
			sourceEvents: [raw("$latest")],
			sendReadReceipt,
		});

		handle.setAtBottom(true);
		await flushPromises();
		handle.setAtBottom(false);
		handle.setAtBottom(true);
		expect(sendReadReceipt).toHaveBeenCalledTimes(2);
		handle.dispose();
	});

	it("does not duplicate a receipt while the same event is in flight", () => {
		let resolveSend: (() => void) | undefined;
		const sendReadReceipt = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveSend = resolve;
				}),
		);
		const handle = mount({
			events: [row("$latest")],
			sourceEvents: [raw("$latest")],
			sendReadReceipt,
		});

		handle.setAtBottom(true);
		handle.setCanLoadNewer(true);
		handle.setCanLoadNewer(false);
		expect(sendReadReceipt).toHaveBeenCalledTimes(1);

		resolveSend?.();
		handle.dispose();
	});

	it("does not let an older completion regress the latest sent receipt", async () => {
		const resolvers: Array<() => void> = [];
		const sendReadReceipt = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const first = raw("$first");
		const second = raw("$second");
		const handle = mount({
			events: [row("$first")],
			sourceEvents: [first, second],
			sendReadReceipt,
		});

		handle.setAtBottom(true);
		handle.setEvents([row("$second")]);
		expect(sendReadReceipt).toHaveBeenCalledTimes(2);

		resolvers[1]?.();
		await flushPromises();
		resolvers[0]?.();
		await flushPromises();
		handle.setAtBottom(false);
		handle.setAtBottom(true);
		expect(sendReadReceipt).toHaveBeenCalledTimes(2);
		handle.dispose();
	});

	it("allows the same event id to send again after a room switch", async () => {
		const source = raw("$same");
		const handle = mount({ events: [row("$same")], sourceEvents: [source] });
		handle.setAtBottom(true);
		await flushPromises();
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(1);

		handle.setRoomId(ROOM_B);
		const roomSwitchFrame = rafCallbacks.at(-1);
		expect(roomSwitchFrame).toBeDefined();
		roomSwitchFrame?.(0);
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(2);
		handle.dispose();
	});

	it("allows the same event id to send with threaded semantics after a scope switch", async () => {
		const source = raw("$same");
		const handle = mount({ events: [row("$same")], sourceEvents: [source] });
		handle.setAtBottom(true);
		await flushPromises();

		handle.setThread({ threadId: "$same" });
		const threadSwitchFrame = rafCallbacks.at(-1);
		threadSwitchFrame?.(0);
		expect(handle.sendReadReceipt).toHaveBeenCalledTimes(2);
		expect(handle.sendReadReceipt).toHaveBeenLastCalledWith(
			source,
			ReceiptType.Read,
			false,
		);
		handle.dispose();
	});
});
