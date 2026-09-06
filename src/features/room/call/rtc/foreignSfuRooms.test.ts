import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createForeignSfuRooms,
	FOREIGN_RETRY_MS,
	type ForeignSfuRoomsDeps,
} from "./foreignSfuRooms";
import { requiredAt } from "./testAssertions";

// Hoisted so the vi.mock factory can reference it.
const { jwtMock } = vi.hoisted(() => ({
	jwtMock: vi.fn(async () => ({ url: "wss://sfu-foreign", jwt: "JWT-F" })),
}));
vi.mock("./fetchLivekitToken", () => ({ fetchLivekitToken: jwtMock }));

const { reportErrorMock } = vi.hoisted(() => ({
	reportErrorMock: vi.fn(),
}));
vi.mock("../../../../lib/reportError", () => ({
	reportError: reportErrorMock,
}));

type Listener = (...args: unknown[]) => void;

interface FakeRoom {
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	setE2EEEnabled: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	emit: (event: string, ...args: unknown[]) => void;
	localParticipant: { identity: string };
	remoteParticipants: Map<string, unknown>;
	activeSpeakers: { identity: string }[];
	options?: unknown;
}

function createFakeRoom(opts?: {
	connectImpl?: () => Promise<void>;
}): FakeRoom {
	const listeners = new Map<string, Set<Listener>>();
	const room: FakeRoom = {
		connect: vi.fn(opts?.connectImpl ?? (async () => {})),
		disconnect: vi.fn(async () => {
			room.emit("disconnected");
		}),
		setE2EEEnabled: vi.fn(async () => {}),
		on: vi.fn((event: string, cb: Listener) => {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(cb);
		}),
		emit: (event: string, ...args: unknown[]) => {
			for (const cb of listeners.get(event) ?? []) cb(...args);
		},
		localParticipant: { identity: "local-id" },
		remoteParticipants: new Map(),
		activeSpeakers: [],
	};
	return room;
}

// Room constructor factory - each `new lk.Room(options)` pulls the next
// fixture (or a fresh default) and records the options it was built with.
const roomQueue: FakeRoom[] = [];
const builtRooms: FakeRoom[] = [];
class MockRoom {
	constructor(options?: unknown) {
		const fixture = roomQueue.shift() ?? createFakeRoom();
		fixture.options = options;
		builtRooms.push(fixture);
		// biome-ignore lint/correctness/noConstructorReturn: test double intentionally substitutes the fixture instance
		return fixture as unknown as MockRoom;
	}
}

const lkMock = {
	Room: MockRoom,
	RoomEvent: {
		ParticipantConnected: "participantConnected",
		ParticipantDisconnected: "participantDisconnected",
		ActiveSpeakersChanged: "activeSpeakersChanged",
		TrackMuted: "trackMuted",
		TrackUnmuted: "trackUnmuted",
		TrackSubscribed: "trackSubscribed",
		TrackUnsubscribed: "trackUnsubscribed",
		Disconnected: "disconnected",
	},
	Track: {
		Kind: { Audio: "audio", Video: "video" },
		Source: {
			Camera: "camera",
			Microphone: "microphone",
			ScreenShare: "screen_share",
		},
	},
} as unknown as typeof import("livekit-client");

const transport = (url: string): LivekitTransport => ({
	type: "livekit",
	livekit_service_url: url,
	livekit_alias: "!room:example.com",
});

const flush = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

interface DepsFixture {
	deps: ForeignSfuRoomsDeps;
	getOpenIdToken: ReturnType<typeof vi.fn>;
	/** Retry timers armed via the seam, in order; call fn() to fire. */
	scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }>;
	attachAudioTrack: ReturnType<typeof vi.fn>;
	detachAudioTrack: ReturnType<typeof vi.fn>;
	upsertVideoTrack: ReturnType<typeof vi.fn>;
	removeVideoTrackIfMatches: ReturnType<typeof vi.fn>;
	upsertScreenShareTrack: ReturnType<typeof vi.fn>;
	removeScreenShareTrackIfMatches: ReturnType<typeof vi.fn>;
	onChanged: ReturnType<typeof vi.fn>;
	onRosterChanged: ReturnType<typeof vi.fn>;
	setNow: (ms: number) => void;
	bindings: Array<{ release: ReturnType<typeof vi.fn> }>;
}

function createDeps(over?: { e2ee?: boolean }): DepsFixture {
	let nowMs = 1_000_000;
	const bindings: Array<{ release: ReturnType<typeof vi.fn> }> = [];
	const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	const getOpenIdToken = vi.fn(async () => ({ access_token: "tok" }));
	const fx = {
		attachAudioTrack: vi.fn(),
		detachAudioTrack: vi.fn(),
		upsertVideoTrack: vi.fn(),
		removeVideoTrackIfMatches: vi.fn(),
		upsertScreenShareTrack: vi.fn(),
		removeScreenShareTrackIfMatches: vi.fn(),
		onChanged: vi.fn(),
		onRosterChanged: vi.fn(),
	};
	const e2eeCtx = over?.e2ee
		? {
				bindRoom: vi.fn((_opts?: { localIdentity?: string }) => {
					const binding = {
						e2eeOptions: { keyProvider: {}, worker: {} },
						release: vi.fn(),
					};
					bindings.push(binding);
					return binding;
				}),
			}
		: null;
	const deps: ForeignSfuRoomsDeps = {
		client: {
			getOpenIdToken,
			getDeviceId: vi.fn(() => "DEVABC"),
			getUserId: vi.fn(() => "@me:example.com"),
		} as never,
		loadLivekit: async () => lkMock,
		e2ee: () => (e2eeCtx as never) ?? null,
		...fx,
		now: () => nowMs,
		retryTimers: {
			setTimer: (fn: () => void, ms: number): unknown => {
				const handle = { fn, ms, cleared: false };
				scheduled.push(handle);
				return handle;
			},
			clearTimer: (handle: unknown): void => {
				(handle as { cleared: boolean }).cleared = true;
			},
		},
	};
	return {
		deps,
		...fx,
		getOpenIdToken,
		scheduled,
		setNow: (ms: number) => {
			nowMs = ms;
		},
		bindings,
	};
}

const desired = (...urls: string[]): Map<string, LivekitTransport> =>
	new Map(urls.map((u) => [new URL(u).origin, transport(u)]));

beforeEach(() => {
	roomQueue.length = 0;
	builtRooms.length = 0;
	jwtMock.mockReset();
	jwtMock.mockResolvedValue({ url: "wss://sfu-foreign", jwt: "JWT-F" });
	reportErrorMock.mockReset();
});

describe("foreignSfuRooms", () => {
	it("connects one subscriber-only room per desired origin", async () => {
		const fx = createDeps();
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(
			desired("https://sfu-a.example.org", "https://sfu-b.example.org"),
		);
		await flush();
		expect(builtRooms).toHaveLength(2);
		expect(
			requiredAt(builtRooms, 0, "foreign room").connect,
		).toHaveBeenCalledWith("wss://sfu-foreign", "JWT-F");
		expect(jwtMock).toHaveBeenCalledTimes(2);
		expect(rooms.rooms().map((r) => r.state)).toEqual([
			"connected",
			"connected",
		]);
		// Subscriber-only: the fake rooms have no publish surface at all -
		// reaching for one would have thrown during connect.
		expect(rooms.stateOf(new URL("https://sfu-a.example.org").origin)).toBe(
			"connected",
		);
	});

	it("is idempotent for an unchanged desired set", async () => {
		const fx = createDeps();
		const rooms = createForeignSfuRooms(fx.deps);
		const set = desired("https://sfu-a.example.org");
		rooms.reconcile(set);
		await flush();
		rooms.reconcile(set);
		await flush();
		expect(builtRooms).toHaveLength(1);
		expect(
			requiredAt(builtRooms, 0, "foreign room").disconnect,
		).not.toHaveBeenCalled();
	});

	it("tears down an origin that leaves the desired set (media cleanup + disconnect)", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		// Subscribe an audio + camera track so teardown has media to clean.
		room.emit(
			"trackSubscribed",
			{ kind: "audio" },
			{ trackSid: "sid-audio", source: "microphone" },
			{ identity: "peer" },
		);
		room.emit(
			"trackSubscribed",
			{ kind: "video" },
			{ trackSid: "sid-cam", source: "camera", isMuted: false },
			{ identity: "peer" },
		);
		expect(fx.attachAudioTrack).toHaveBeenCalledTimes(1);
		expect(fx.upsertVideoTrack).toHaveBeenCalledWith(
			"peer",
			{ kind: "video" },
			"sid-cam",
		);
		rooms.reconcile(new Map());
		await flush();
		expect(fx.detachAudioTrack).toHaveBeenCalledWith("sid-audio");
		expect(fx.removeVideoTrackIfMatches).toHaveBeenCalledWith(
			"peer",
			"sid-cam",
		);
		expect(room.disconnect).toHaveBeenCalledTimes(1);
		expect(rooms.rooms()).toHaveLength(0);
	});

	it("skips a camera track already muted at subscribe time and adds it on unmute", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org"),
		);
		await flush();
		room.emit(
			"trackSubscribed",
			{ kind: "video" },
			{ trackSid: "sid-cam", source: "camera", isMuted: true },
			{ identity: "peer" },
		);
		expect(fx.upsertVideoTrack).not.toHaveBeenCalled();
		room.emit(
			"trackUnmuted",
			{
				trackSid: "sid-cam",
				source: "camera",
				isMuted: false,
				videoTrack: { kind: "video" },
			},
			{ identity: "peer" },
		);
		expect(fx.upsertVideoTrack).toHaveBeenCalledWith(
			"peer",
			{ kind: "video" },
			"sid-cam",
		);
		room.emit(
			"trackMuted",
			{ trackSid: "sid-cam", source: "camera", isMuted: true },
			{ identity: "peer" },
		);
		expect(fx.removeVideoTrackIfMatches).toHaveBeenCalledWith(
			"peer",
			"sid-cam",
		);
	});

	it("routes screen-share video into the screen-share map, not the camera map", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org"),
		);
		await flush();
		room.emit(
			"trackSubscribed",
			{ kind: "video" },
			{ trackSid: "sid-share", source: "screen_share" },
			{ identity: "peer" },
		);
		expect(fx.upsertScreenShareTrack).toHaveBeenCalledWith(
			"peer",
			{ kind: "video" },
			"sid-share",
		);
		expect(fx.upsertVideoTrack).not.toHaveBeenCalled();
	});

	it("purges a departed participant's media from this origin only", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org"),
		);
		await flush();
		room.emit(
			"trackSubscribed",
			{ kind: "video" },
			{ trackSid: "sid-cam", source: "camera", isMuted: false },
			{ identity: "peer" },
		);
		room.emit("participantDisconnected", { identity: "peer" });
		expect(fx.removeVideoTrackIfMatches).toHaveBeenCalledWith(
			"peer",
			"sid-cam",
		);
		expect(fx.onRosterChanged).toHaveBeenCalled();
	});

	it("scans already-subscribed publications on connect (in-progress call race)", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		room.remoteParticipants.set("peer", {
			identity: "peer",
			audioTrackPublications: new Map([
				[
					"sid-audio",
					{
						trackSid: "sid-audio",
						isSubscribed: true,
						audioTrack: { kind: "audio" },
					},
				],
			]),
			videoTrackPublications: new Map([
				[
					"sid-cam",
					{
						trackSid: "sid-cam",
						source: "camera",
						isMuted: false,
						isSubscribed: true,
						videoTrack: { kind: "video" },
					},
				],
			]),
		});
		roomQueue.push(room);
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org"),
		);
		await flush();
		expect(fx.attachAudioTrack).toHaveBeenCalledTimes(1);
		expect(fx.upsertVideoTrack).toHaveBeenCalledWith(
			"peer",
			{ kind: "video" },
			"sid-cam",
		);
	});

	it("isolates a failed connect: state failed, console-only report, siblings unaffected", async () => {
		const fx = createDeps();
		jwtMock
			.mockRejectedValueOnce(new Error("451 blocked"))
			.mockResolvedValueOnce({ url: "wss://sfu-b", jwt: "JWT-B" });
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(
			desired("https://sfu-a.example.org", "https://sfu-b.example.org"),
		);
		await flush();
		const states = new Map(rooms.rooms().map((r) => [r.origin, r.state]));
		expect(states.get("https://sfu-a.example.org")).toBe("failed");
		expect(states.get("https://sfu-b.example.org")).toBe("connected");
		expect(reportErrorMock).toHaveBeenCalledTimes(1);
		// Console-only: no userMessage (the #494 badge is the user-facing
		// signal for an unreachable peer).
		expect(
			requiredAt(reportErrorMock.mock.calls, 0, "reported error")[1],
		).not.toHaveProperty("userMessage");
	});

	it("retries a failed origin only after the backoff elapses", async () => {
		const fx = createDeps();
		jwtMock.mockRejectedValueOnce(new Error("boom"));
		const rooms = createForeignSfuRooms(fx.deps);
		const set = desired("https://sfu-a.example.org");
		rooms.reconcile(set);
		await flush();
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"failed",
		);
		// Within the backoff: reconcile must NOT re-attempt.
		rooms.reconcile(set);
		await flush();
		expect(jwtMock).toHaveBeenCalledTimes(1);
		// After the backoff: retried and (jwtMock now resolves) connected.
		fx.setNow(1_000_000 + FOREIGN_RETRY_MS);
		rooms.reconcile(set);
		await flush();
		expect(jwtMock).toHaveBeenCalledTimes(2);
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"connected",
		);
	});

	it("marks an unsolicited room drop failed and reclaims its media", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		room.emit(
			"trackSubscribed",
			{ kind: "audio" },
			{ trackSid: "sid-audio", source: "microphone" },
			{ identity: "peer" },
		);
		room.emit("disconnected");
		await flush();
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"failed",
		);
		expect(fx.detachAudioTrack).toHaveBeenCalledWith("sid-audio");
	});

	it("a reconcile that removes an origin mid-connect wins over the in-flight connect", async () => {
		const fx = createDeps();
		let releaseToken: (v: { url: string; jwt: string }) => void = () => {};
		jwtMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseToken = resolve;
				}),
		);
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		// Still parked on the token fetch; drop the origin.
		rooms.reconcile(new Map());
		releaseToken({ url: "wss://late", jwt: "LATE" });
		await flush();
		// The stale connect must not have built (or connected) a Room.
		expect(builtRooms).toHaveLength(0);
		expect(rooms.rooms()).toHaveLength(0);
	});

	it("binds E2EE per room before construction, enables it before connect, releases after teardown", async () => {
		const fx = createDeps({ e2ee: true });
		const room = createFakeRoom();
		roomQueue.push(room);
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		expect(fx.bindings).toHaveLength(1);
		// The Room was constructed with this binding's e2ee options.
		expect((room.options as { e2ee?: unknown }).e2ee).toBe(
			(fx.bindings[0] as unknown as { e2eeOptions: unknown }).e2eeOptions,
		);
		// Ordering: E2EE enabled before the websocket connects.
		expect(room.setE2EEEnabled).toHaveBeenCalledWith(true);
		expect(room.setE2EEEnabled.mock.invocationCallOrder[0]).toBeLessThan(
			requiredAt(
				room.connect.mock.invocationCallOrder,
				0,
				"connect call order",
			),
		);
		rooms.reconcile(new Map());
		await flush();
		// Released only after disconnect resolved.
		expect(
			requiredAt(fx.bindings, 0, "E2EE binding").release,
		).toHaveBeenCalledTimes(1);
		expect(room.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
			requiredAt(
				requiredAt(fx.bindings, 0, "E2EE binding").release.mock
					.invocationCallOrder,
				0,
				"release call order",
			),
		);
	});

	it("skips setE2EEEnabled entirely for unencrypted calls", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org"),
		);
		await flush();
		expect(room.setE2EEEnabled).not.toHaveBeenCalled();
	});

	it("clear() tears everything down but the instance stays usable", async () => {
		const fx = createDeps();
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		await rooms.clear();
		expect(
			requiredAt(builtRooms, 0, "foreign room").disconnect,
		).toHaveBeenCalled();
		expect(rooms.rooms()).toHaveLength(0);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		expect(builtRooms).toHaveLength(2);
	});

	it("shares one OpenID token across a reconcile wave", async () => {
		const fx = createDeps();
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org", "https://sfu-b.example.org"),
		);
		await flush();
		expect(jwtMock).toHaveBeenCalledTimes(2);
		expect(fx.getOpenIdToken).toHaveBeenCalledTimes(1);
	});

	it("a timer retries a dropped origin without waiting for a membership tick", async () => {
		const fx = createDeps();
		const room = createFakeRoom();
		roomQueue.push(room);
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		room.emit("disconnected");
		await flush();
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"failed",
		);
		const armed = fx.scheduled.filter((t) => !t.cleared);
		expect(armed).toHaveLength(1);
		expect(requiredAt(armed, 0, "retry timer").ms).toBe(FOREIGN_RETRY_MS);
		// Fire the timer: the origin reconnects with NO reconcile call.
		roomQueue.push(createFakeRoom());
		requiredAt(armed, 0, "retry timer").fn();
		await flush();
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"connected",
		);
		expect(jwtMock).toHaveBeenCalledTimes(2);
	});

	it("a timer retry dials the latest transport, not the one that failed", async () => {
		// The transport for an origin can be re-published with a different
		// spelling/path while the origin sits in backoff; a reconcile inside
		// the backoff must still refresh the dial target so the timer retry
		// does not reconnect via the stale endpoint.
		const fx = createDeps();
		jwtMock.mockRejectedValueOnce(new Error("boom"));
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"failed",
		);
		// Same origin, updated path - arrives within the backoff window.
		const updated = transport("https://sfu-a.example.org/livekit");
		rooms.reconcile(
			new Map([[new URL("https://sfu-a.example.org").origin, updated]]),
		);
		await flush();
		expect(jwtMock).toHaveBeenCalledTimes(1);
		roomQueue.push(createFakeRoom());
		const armed = fx.scheduled.filter((t) => !t.cleared);
		requiredAt(armed, armed.length - 1, "latest retry timer").fn();
		await flush();
		expect(jwtMock).toHaveBeenCalledTimes(2);
		expect((jwtMock.mock.calls[1] as unknown[])[0]).toEqual(updated);
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"connected",
		);
	});

	it("removing an origin cancels its armed retry timer", async () => {
		const fx = createDeps();
		jwtMock.mockRejectedValueOnce(new Error("boom"));
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		expect(fx.scheduled.filter((t) => !t.cleared)).toHaveLength(1);
		rooms.reconcile(new Map());
		await flush();
		expect(fx.scheduled.filter((t) => !t.cleared)).toHaveLength(0);
		// A stale-fired timer (defensive) must not resurrect the origin.
		for (const t of fx.scheduled) t.fn();
		await flush();
		expect(rooms.rooms()).toHaveLength(0);
	});

	it("a sink throw during the post-connect scan reclaims the connected room", async () => {
		// The already-subscribed scan runs before promotion; if a shared
		// media sink throws, the catch must disconnect the room and release
		// its binding rather than leaking them into the retry.
		const fx = createDeps({ e2ee: true });
		fx.attachAudioTrack.mockImplementationOnce(() => {
			throw new Error("sink exploded");
		});
		const room = createFakeRoom();
		room.remoteParticipants.set("peer", {
			identity: "peer",
			audioTrackPublications: new Map([
				[
					"sid-audio",
					{
						trackSid: "sid-audio",
						isSubscribed: true,
						audioTrack: { kind: "audio" },
					},
				],
			]),
			videoTrackPublications: new Map(),
		});
		roomQueue.push(room);
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").state).toBe(
			"failed",
		);
		expect(requiredAt(rooms.rooms(), 0, "foreign room state").room).toBeNull();
		expect(room.disconnect).toHaveBeenCalledTimes(1);
		expect(
			requiredAt(fx.bindings, 0, "E2EE binding").release,
		).toHaveBeenCalledTimes(1);
	});

	it("passes the local userId:deviceId identity to bindRoom for replay ordering", async () => {
		const fx = createDeps({ e2ee: true });
		roomQueue.push(createFakeRoom());
		createForeignSfuRooms(fx.deps).reconcile(
			desired("https://sfu-a.example.org"),
		);
		await flush();
		const e2eeCtx = fx.deps.e2ee() as unknown as {
			bindRoom: ReturnType<typeof vi.fn>;
		};
		expect(e2eeCtx.bindRoom).toHaveBeenCalledWith({
			localIdentity: "@me:example.com:DEVABC",
		});
	});

	it("disposeAll() is terminal: a late reconcile cannot reconnect", async () => {
		const fx = createDeps();
		const rooms = createForeignSfuRooms(fx.deps);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		await rooms.disposeAll();
		expect(rooms.rooms()).toHaveLength(0);
		rooms.reconcile(desired("https://sfu-a.example.org"));
		await flush();
		expect(builtRooms).toHaveLength(1);
	});
});
