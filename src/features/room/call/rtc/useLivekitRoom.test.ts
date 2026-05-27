import { renderHook } from "@solidjs/testing-library";
import type {
	CallMembership,
	LivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks — vi.mock factories run before module imports.
const { roomFactory, lkMock, jwtMock } = vi.hoisted(() => {
	// A `vi.fn()` cannot be invoked with `new` in vitest 4 unless its
	// implementation is a class/function (not an arrow). Use a real class
	// that delegates to a hoisted factory so each test can swap which
	// FakeRoom instance the constructor returns.
	const roomFactory = {
		current: null as null | (() => unknown),
		callCount: 0,
	};
	class MockRoom {
		constructor() {
			roomFactory.callCount += 1;
			if (!roomFactory.current) {
				throw new Error("roomFactory.current not set by test");
			}
			Object.assign(this, roomFactory.current());
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
			LocalTrackPublished: "localTrackPublished",
			Disconnected: "disconnected",
		},
		Track: { Kind: { Audio: "audio", Video: "video" } },
	};
	const jwtMock = vi.fn(async () => ({ url: "wss://sfu", jwt: "JWT" }));
	return { roomFactory, lkMock, jwtMock };
});

vi.mock("./fetchLivekitToken", () => ({
	fetchLivekitToken: jwtMock,
	LivekitJwtError: class LivekitJwtError extends Error {
		status: number | null = null;
	},
}));

import { useLivekitRoom } from "./useLivekitRoom";

const loadLivekit = async () =>
	lkMock as unknown as typeof import("livekit-client");

type Listener = (...args: unknown[]) => void;

interface FakeRoom {
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
	emit: (event: string, ...args: unknown[]) => void;
	startAudio: ReturnType<typeof vi.fn>;
	localParticipant: {
		identity: string;
		isMicrophoneEnabled: boolean;
		setMicrophoneEnabled: ReturnType<typeof vi.fn>;
	};
	remoteParticipants: Map<string, unknown>;
	activeSpeakers: { identity: string }[];
}

function createFakeRoom(opts?: {
	connectImpl?: () => Promise<void>;
	enableMicImpl?: () => Promise<void>;
}): FakeRoom {
	const listeners = new Map<string, Set<Listener>>();
	const localParticipant = {
		identity: "local-id",
		isMicrophoneEnabled: false,
		setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
			if (opts?.enableMicImpl) await opts.enableMicImpl();
			localParticipant.isMicrophoneEnabled = enabled;
		}),
	};
	const room: FakeRoom = {
		connect: vi.fn(opts?.connectImpl ?? (async () => {})),
		disconnect: vi.fn(async () => {
			room.emit("disconnected");
		}),
		on: vi.fn((event: string, cb: Listener) => {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(cb);
		}),
		off: vi.fn((event: string, cb: Listener) => {
			listeners.get(event)?.delete(cb);
		}),
		emit: (event: string, ...args: unknown[]) => {
			for (const cb of listeners.get(event) ?? []) cb(...args);
		},
		startAudio: vi.fn(async () => {}),
		localParticipant,
		remoteParticipants: new Map(),
		activeSpeakers: [],
	};
	return room;
}

function createClient(): {
	client: {
		getOpenIdToken: ReturnType<typeof vi.fn>;
		getUser: ReturnType<typeof vi.fn>;
	};
} {
	return {
		client: {
			getOpenIdToken: vi.fn(async () => ({
				access_token: "tok",
				token_type: "Bearer",
				matrix_server_name: "example.com",
				expires_in: 3600,
			})),
			getUser: vi.fn(() => ({ displayName: "Alice" })),
		},
	};
}

const livekitFocus: LivekitTransport = {
	type: "livekit",
	livekit_service_url: "https://sfu.example.com/livekit/sfu/get",
	livekit_alias: "!room:example.com",
};

beforeEach(() => {
	roomFactory.current = null;
	roomFactory.callCount = 0;
	jwtMock.mockReset();
	jwtMock.mockResolvedValue({ url: "wss://sfu", jwt: "JWT" });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const waitFor = async (
	pred: () => unknown,
	timeoutMs = 1000,
): Promise<void> => {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((r) => setTimeout(r, 5));
	}
};

describe("useLivekitRoom", () => {
	it("does not connect while disabled or focus is null", async () => {
		const { client } = createClient();
		renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => null,
				enabled: () => false,
				memberships: () => [],
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await flush();
		expect(roomFactory.callCount).toBe(0);
		expect(jwtMock).not.toHaveBeenCalled();
	});

	it("connects, publishes mic, and reports connected status", async () => {
		const fakeRoom = createFakeRoom();
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(jwtMock).toHaveBeenCalledTimes(1);
		expect(fakeRoom.connect).toHaveBeenCalledWith("wss://sfu", "JWT");
		expect(fakeRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
			true,
		);
		expect(result.localMuted()).toBe(false);
	});

	it("aborts publish when disabled flips false mid-connect", async () => {
		let resolveConnect: (() => void) | undefined;
		const fakeRoom = createFakeRoom({
			connectImpl: () =>
				new Promise<void>((res) => {
					resolveConnect = res;
				}),
		});
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const [enabled, setEnabled] = createSignal(true);
		renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled,
				memberships: () => [],
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => fakeRoom.connect.mock.calls.length === 1);
		setEnabled(false);
		resolveConnect?.();
		await waitFor(() => fakeRoom.disconnect.mock.calls.length > 0);
		// Must not publish a mic track on a stale connect attempt.
		expect(
			fakeRoom.localParticipant.setMicrophoneEnabled,
		).not.toHaveBeenCalled();
	});

	it("does not reconnect when only audioDeviceId changes", async () => {
		const fakeRoom = createFakeRoom();
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const [deviceId, setDeviceId] = createSignal("");
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: deviceId,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(roomFactory.callCount).toBe(1);
		setDeviceId("different-mic");
		await flush();
		await flush();
		expect(roomFactory.callCount).toBe(1);
	});

	it("optimistically toggles mute and calls setMicrophoneEnabled", async () => {
		const fakeRoom = createFakeRoom();
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		fakeRoom.localParticipant.setMicrophoneEnabled.mockClear();
		const p = result.setLocalMuted(true);
		// Optimistic — UI reflects mute before LiveKit settles.
		expect(result.localMuted()).toBe(true);
		await p;
		expect(fakeRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
			false,
		);
	});

	it("disconnect tears down the room and returns to idle", async () => {
		const fakeRoom = createFakeRoom();
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.disconnect();
		expect(fakeRoom.disconnect).toHaveBeenCalled();
		expect(result.status()).toBe("idle");
	});

	it("resolves participant display name via membership rtcBackendIdentity", async () => {
		const fakeRoom = createFakeRoom();
		// Add a remote participant with no audio publications.
		fakeRoom.remoteParticipants.set("remote-bid", {
			identity: "remote-bid",
			audioTrackPublications: new Map(),
		});
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		client.getUser.mockImplementation((userId: string) =>
			userId === "@bob:example.com" ? { displayName: "Bob" } : null,
		);
		const memberships: CallMembership[] = [
			{
				rtcBackendIdentity: "remote-bid",
				userId: "@bob:example.com",
				deviceId: "BBB",
			} as unknown as CallMembership,
		];
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => memberships,
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remote = result.participants().find((p) => !p.isLocal);
		expect(remote?.displayName).toBe("Bob");
	});

	it("surfaces JWT fetch errors as error status", async () => {
		jwtMock.mockRejectedValueOnce(new Error("401 Unauthorized"));
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "error");
		expect(result.error()?.message).toContain("401");
	});
});
