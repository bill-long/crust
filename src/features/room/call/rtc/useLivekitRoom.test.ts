import { renderHook } from "@solidjs/testing-library";
import type {
	CallMembership,
	LivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc";
import { createRoot, createSignal } from "solid-js";
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
		lastOptions: null as unknown,
	};
	class MockRoom {
		constructor(options?: unknown) {
			roomFactory.callCount += 1;
			roomFactory.lastOptions = options;
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
			LocalTrackUnpublished: "localTrackUnpublished",
			Disconnected: "disconnected",
		},
		Track: {
			Kind: { Audio: "audio", Video: "video" },
			Source: { Camera: "camera", Microphone: "microphone" },
		},
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
	setE2EEEnabled: ReturnType<typeof vi.fn>;
	localParticipant: {
		identity: string;
		isMicrophoneEnabled: boolean;
		isCameraEnabled: boolean;
		setMicrophoneEnabled: ReturnType<typeof vi.fn>;
		setCameraEnabled: ReturnType<typeof vi.fn>;
		audioTrackPublications: Map<string, unknown>;
		videoTrackPublications: Map<string, unknown>;
	};
	remoteParticipants: Map<string, unknown>;
	activeSpeakers: { identity: string }[];
}

function createFakeRoom(opts?: {
	connectImpl?: () => Promise<void>;
	enableMicImpl?: () => Promise<void>;
	setE2EEEnabledImpl?: (enabled: boolean) => Promise<void>;
}): FakeRoom {
	const listeners = new Map<string, Set<Listener>>();
	const localParticipant = {
		identity: "local-id",
		isMicrophoneEnabled: false,
		isCameraEnabled: false,
		setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
			if (opts?.enableMicImpl) await opts.enableMicImpl();
			localParticipant.isMicrophoneEnabled = enabled;
		}),
		setCameraEnabled: vi.fn(async (enabled: boolean) => {
			localParticipant.isCameraEnabled = enabled;
		}),
		audioTrackPublications: new Map(),
		videoTrackPublications: new Map(),
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
		setE2EEEnabled: vi.fn(opts?.setE2EEEnabledImpl ?? (async () => {})),
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
		getDeviceId: ReturnType<typeof vi.fn>;
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
			getDeviceId: vi.fn(() => "DEVABC123"),
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
	roomFactory.lastOptions = null;
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
				videoDeviceId: () => "",
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(jwtMock).toHaveBeenCalledTimes(1);
		// lk-jwt-service derives LiveKit participant identity from
		// `device_id` (see fetchLivekitToken.ts jsdoc); confirm we forward it.
		expect(jwtMock).toHaveBeenCalledWith(
			livekitFocus,
			expect.objectContaining({ access_token: "tok" }),
			"DEVABC123",
		);
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
				videoDeviceId: () => "",
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
				videoDeviceId: () => "",
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
				videoDeviceId: () => "",
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.disconnect();
		expect(fakeRoom.disconnect).toHaveBeenCalled();
		expect(result.status()).toBe("idle");
	});

	it("teardownComplete resolves AFTER the cleanup teardown finishes disconnect", async () => {
		const fakeRoom = createFakeRoom();
		// Hold disconnect open so we can observe that teardownComplete is
		// still pending while r.disconnect() hasn't resolved.
		let releaseDisconnect: () => void = () => {};
		const disconnectGate = new Promise<void>((res) => {
			releaseDisconnect = res;
		});
		fakeRoom.disconnect.mockImplementation(async () => {
			await disconnectGate;
		});
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		let api: ReturnType<typeof useLivekitRoom> | null = null;
		const dispose = createRoot((d) => {
			api = useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				loadLivekit,
			});
			return d;
		});
		// biome-ignore lint/style/noNonNullAssertion: assigned synchronously in createRoot
		await waitFor(() => api!.status() === "connected");
		// Trigger the cleanup branch (which sets teardownPromise = teardown())
		dispose();
		// biome-ignore lint/style/noNonNullAssertion: assigned synchronously in createRoot
		const tearPromise = api!.teardownComplete();
		// Race: teardownComplete should NOT resolve while disconnect is held.
		let resolved = false;
		void tearPromise.then(() => {
			resolved = true;
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false);
		// Release disconnect; teardownComplete must now resolve.
		releaseDisconnect();
		await tearPromise;
		expect(resolved).toBe(true);
		expect(fakeRoom.disconnect).toHaveBeenCalled();
	});

	it("resolves participant display name via membership rtcBackendIdentity", async () => {
		const fakeRoom = createFakeRoom();
		// Add a remote participant with no audio publications.
		fakeRoom.remoteParticipants.set("remote-bid", {
			identity: "remote-bid",
			audioTrackPublications: new Map(),
			videoTrackPublications: new Map(),
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
				videoDeviceId: () => "",
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "error");
		expect(result.error()?.message).toContain("401");
	});

	it("surfaces missing Matrix device ID as error status before calling JWT", async () => {
		// lk-jwt-service builds LiveKit participant identity from the
		// device_id we send; without it, the JWT identity silently
		// mismatches matrix-js-sdk's rtcBackendIdentity and outbound
		// E2EE breaks. Fail fast at the boundary instead.
		const { client } = createClient();
		client.getDeviceId.mockReturnValueOnce(null);
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "error");
		expect(result.error()?.message).toContain("device ID");
		expect(jwtMock).not.toHaveBeenCalled();
	});

	it("setLocalCamEnabled(true) calls setCameraEnabled with deviceId and reflects publish", async () => {
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
				videoDeviceId: () => "cam-abc",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(result.localCamEnabled()).toBe(false);
		await result.setLocalCamEnabled(true);
		expect(fakeRoom.localParticipant.setCameraEnabled).toHaveBeenCalledWith(
			true,
			{ deviceId: "cam-abc" },
		);
		expect(result.localCamEnabled()).toBe(true);
		// Simulate LocalTrackPublished for the local camera and verify the
		// reconcile picks it up into videoTracks via reconcileLocalCamera.
		const localTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		fakeRoom.localParticipant.videoTrackPublications.set("pub-local-cam", {
			source: "camera",
			videoTrack: localTrack,
			isSubscribed: true,
			trackSid: "pub-local-cam",
		});
		fakeRoom.emit("localTrackPublished");
		expect(result.videoTracks().get("local-id")?.track).toBe(localTrack);
	});

	it("setLocalCamEnabled(false) unpublishes and removes local entry on LocalTrackUnpublished", async () => {
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.setLocalCamEnabled(true);
		const localTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		fakeRoom.localParticipant.videoTrackPublications.set("pub-local-cam", {
			source: "camera",
			videoTrack: localTrack,
			isSubscribed: true,
			trackSid: "pub-local-cam",
		});
		fakeRoom.emit("localTrackPublished");
		expect(result.videoTracks().has("local-id")).toBe(true);

		await result.setLocalCamEnabled(false);
		expect(fakeRoom.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
			false,
			{ deviceId: undefined },
		);
		// Simulate LiveKit removing the camera publication and emitting unpublished.
		fakeRoom.localParticipant.videoTrackPublications.clear();
		fakeRoom.emit("localTrackUnpublished");
		expect(result.localCamEnabled()).toBe(false);
		expect(result.videoTracks().has("local-id")).toBe(false);
	});

	it("remote camera TrackSubscribed adds a videoTracks entry; TrackUnsubscribed removes it", async () => {
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remoteTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		const remotePub = { source: "camera", trackSid: "remote-sid-1" };
		fakeRoom.emit("trackSubscribed", remoteTrack, remotePub, {
			identity: "remote-1",
		});
		expect(result.videoTracks().get("remote-1")?.track).toBe(remoteTrack);
		expect(result.videoTracks().get("remote-1")?.sid).toBe("remote-sid-1");

		fakeRoom.emit("trackUnsubscribed", remoteTrack, remotePub, {
			identity: "remote-1",
		});
		expect(result.videoTracks().has("remote-1")).toBe(false);
	});

	it("stale TrackUnsubscribed with a different sid does NOT wipe a fresh replacement entry", async () => {
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const oldTrack = { kind: "video" };
		const newTrack = { kind: "video" };
		fakeRoom.emit(
			"trackSubscribed",
			oldTrack,
			{ source: "camera", trackSid: "old-sid" },
			{ identity: "remote-1" },
		);
		// Replace with a new publication (e.g. camera-device switch).
		fakeRoom.emit(
			"trackSubscribed",
			newTrack,
			{ source: "camera", trackSid: "new-sid" },
			{ identity: "remote-1" },
		);
		expect(result.videoTracks().get("remote-1")?.track).toBe(newTrack);
		// Late unsubscribe for the old publication must NOT delete the new one.
		fakeRoom.emit(
			"trackUnsubscribed",
			oldTrack,
			{ source: "camera", trackSid: "old-sid" },
			{ identity: "remote-1" },
		);
		expect(result.videoTracks().get("remote-1")?.track).toBe(newTrack);
	});

	it("ParticipantDisconnected purges that participant's video entry", async () => {
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remoteTrack = { kind: "video" };
		fakeRoom.emit(
			"trackSubscribed",
			remoteTrack,
			{ source: "camera", trackSid: "r-sid" },
			{ identity: "remote-x" },
		);
		expect(result.videoTracks().has("remote-x")).toBe(true);
		fakeRoom.emit("participantDisconnected", { identity: "remote-x" });
		expect(result.videoTracks().has("remote-x")).toBe(false);
	});

	it("non-camera video publications are ignored (e.g. screen-share)", async () => {
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
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		fakeRoom.emit(
			"trackSubscribed",
			{ kind: "video" },
			{ source: "screen_share", trackSid: "ss-sid" },
			{ identity: "remote-1" },
		);
		expect(result.videoTracks().has("remote-1")).toBe(false);
	});

	it("does not reconnect when only videoDeviceId changes", async () => {
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
				audioDeviceId: () => "",
				videoDeviceId: deviceId,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(roomFactory.callCount).toBe(1);
		setDeviceId("different-cam");
		await flush();
		expect(roomFactory.callCount).toBe(1);
	});

	it("setLocalCamEnabled reverts optimistic flag and surfaces error when setCameraEnabled rejects", async () => {
		const fakeRoom = createFakeRoom();
		fakeRoom.localParticipant.setCameraEnabled.mockImplementation(async () => {
			throw new Error("cam denied");
		});
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.setLocalCamEnabled(true);
		// Optimistic flag reverted to actual (still false on the fake).
		expect(result.localCamEnabled()).toBe(false);
		expect(result.error()?.message).toContain("cam denied");
	});

	it("setLocalCamEnabled stale-bails when disconnect lands mid-await", async () => {
		const fakeRoom = createFakeRoom();
		let release: () => void = () => {};
		fakeRoom.localParticipant.setCameraEnabled.mockImplementation(
			() =>
				new Promise<void>((r) => {
					release = r;
				}),
		);
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const pending = result.setLocalCamEnabled(true);
		// Teardown bumps the attempt epoch mid-await; post-await reconciliation
		// must bail out (no setError on a dead room).
		await result.disconnect();
		release();
		await pending;
		expect(result.error()).toBeNull();
		expect(result.status()).toBe("idle");
	});

	it("rapid enable→disable while setCameraEnabled is in flight settles on disable (intent not clobbered by LocalTrackPublished)", async () => {
		const fakeRoom = createFakeRoom();
		// Simulate LiveKit emitting LocalTrackPublished synchronously inside
		// setCameraEnabled(true) BEFORE the publish promise resolves — the
		// race window that previously let reconcileLocalCamera overwrite a
		// user's mid-await "disable" intent.
		let releaseEnable: () => void = () => {};
		fakeRoom.localParticipant.setCameraEnabled.mockImplementationOnce(
			async (enabled: boolean) => {
				fakeRoom.localParticipant.isCameraEnabled = enabled;
				if (enabled) {
					const localTrack = { kind: "video" };
					fakeRoom.localParticipant.videoTrackPublications.set("pub-cam", {
						source: "camera",
						videoTrack: localTrack,
						isSubscribed: true,
						trackSid: "pub-cam",
					});
					fakeRoom.emit("localTrackPublished");
				}
				await new Promise<void>((r) => {
					releaseEnable = r;
				});
			},
		);
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const enablePromise = result.setLocalCamEnabled(true);
		// LocalTrackPublished has now fired (synchronously inside the
		// mocked setCameraEnabled body). User clicks Stop before enable
		// resolves — must NOT be silently lost.
		await result.setLocalCamEnabled(false);
		expect(result.localCamEnabled()).toBe(false);
		releaseEnable();
		await enablePromise;
		// The loop should re-run, see desired=false / actual=true, and
		// call setCameraEnabled(false) to honor the user's last intent.
		expect(fakeRoom.localParticipant.setCameraEnabled).toHaveBeenCalledTimes(2);
		expect(fakeRoom.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(
			false,
			{ deviceId: undefined },
		);
		expect(result.localCamEnabled()).toBe(false);
	});

	describe("Phase 4 E2EE wiring", () => {
		const fakeE2EECtx = (): {
			ctx: import("./rtcE2EEBridge").RtcE2EEContext;
			e2eeOptions: { keyProvider: never; worker: never };
			release: ReturnType<typeof vi.fn>;
			bindRoom: ReturnType<typeof vi.fn>;
		} => {
			const e2eeOptions = {
				keyProvider: { __tag: "kp" } as never,
				worker: { __tag: "w" } as never,
			};
			const release = vi.fn();
			const bindRoom = vi.fn(() => ({ e2eeOptions, release }));
			const ctx = {
				attach: () => () => {},
				reemit: () => {},
				bindRoom,
				dispose: () => {},
			} as unknown as import("./rtcE2EEBridge").RtcE2EEContext;
			return { ctx, e2eeOptions, release, bindRoom };
		};

		it("constructs Room with e2ee options from a fresh per-Room binding", async () => {
			const fakeRoom = createFakeRoom();
			roomFactory.current = () => fakeRoom;
			const { client } = createClient();
			const { ctx, e2eeOptions, bindRoom } = fakeE2EECtx();
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => livekitFocus,
					enabled: () => true,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					loadLivekit,
					e2ee: () => ctx,
				}),
			);
			await waitFor(() => result.status() === "connected");
			const opts = roomFactory.lastOptions as { e2ee?: unknown };
			expect(opts?.e2ee).toBe(e2eeOptions);
			expect(bindRoom).toHaveBeenCalledTimes(1);
		});

		it("releases the binding AFTER room.disconnect on teardown", async () => {
			const fakeRoom = createFakeRoom();
			roomFactory.current = () => fakeRoom;
			const { client } = createClient();
			const { ctx, release } = fakeE2EECtx();
			const [enabled, setEnabled] = createSignal(true);
			renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => livekitFocus,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					loadLivekit,
					e2ee: () => ctx,
				}),
			);
			await waitFor(() => fakeRoom.connect.mock.calls.length === 1);
			setEnabled(false);
			await waitFor(() => release.mock.calls.length === 1);
			const disconnectOrder = fakeRoom.disconnect.mock.invocationCallOrder[0];
			const releaseOrder = release.mock.invocationCallOrder[0];
			expect(disconnectOrder).toBeLessThan(releaseOrder);
		});

		it("awaits setE2EEEnabled(true) BEFORE room.connect()", async () => {
			const fakeRoom = createFakeRoom();
			roomFactory.current = () => fakeRoom;
			const { client } = createClient();
			const { ctx } = fakeE2EECtx();
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => livekitFocus,
					enabled: () => true,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					loadLivekit,
					e2ee: () => ctx,
				}),
			);
			await waitFor(() => result.status() === "connected");
			expect(fakeRoom.setE2EEEnabled).toHaveBeenCalledWith(true);
			const e2eeOrder = fakeRoom.setE2EEEnabled.mock.invocationCallOrder[0];
			const connectOrder = fakeRoom.connect.mock.invocationCallOrder[0];
			expect(e2eeOrder).toBeLessThan(connectOrder);
		});

		it("aborts connect when disabled flips false mid setE2EEEnabled", async () => {
			let releaseSetE2EE: (() => void) | undefined;
			const fakeRoom = createFakeRoom({
				setE2EEEnabledImpl: () =>
					new Promise<void>((res) => {
						releaseSetE2EE = res;
					}),
			});
			roomFactory.current = () => fakeRoom;
			const { client } = createClient();
			const [enabled, setEnabled] = createSignal(true);
			const { ctx, release } = fakeE2EECtx();
			renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => livekitFocus,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					loadLivekit,
					e2ee: () => ctx,
				}),
			);
			await waitFor(() => fakeRoom.setE2EEEnabled.mock.calls.length === 1);
			setEnabled(false);
			releaseSetE2EE?.();
			await flush();
			await flush();
			expect(fakeRoom.connect).not.toHaveBeenCalled();
			expect(
				fakeRoom.localParticipant.setMicrophoneEnabled,
			).not.toHaveBeenCalled();
			// The stale-attempt arm in useLivekitRoom MUST release the
			// per-Room binding it created — otherwise a superseded
			// connect leaks its keyProvider+worker pair.
			expect(release).toHaveBeenCalledTimes(1);
		});

		it("releases the binding when the Room emits an unsolicited Disconnected", async () => {
			const fakeRoom = createFakeRoom();
			roomFactory.current = () => fakeRoom;
			const { client } = createClient();
			const { ctx, release } = fakeE2EECtx();
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => livekitFocus,
					enabled: () => true,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					loadLivekit,
					e2ee: () => ctx,
				}),
			);
			await waitFor(() => result.status() === "connected");
			expect(release).not.toHaveBeenCalled();
			// Simulate the SFU dropping the websocket without us asking.
			// If the Disconnected handler doesn't release the binding,
			// the next connect would overwrite `binding` and the
			// keyProvider+worker pair would leak.
			fakeRoom.emit("disconnected");
			expect(release).toHaveBeenCalledTimes(1);
		});

		it("does not call setE2EEEnabled when no bridge is provided", async () => {
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
					videoDeviceId: () => "",
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");
			expect(fakeRoom.setE2EEEnabled).not.toHaveBeenCalled();
			const opts = roomFactory.lastOptions as { e2ee?: unknown };
			expect(opts?.e2ee).toBeUndefined();
		});
	});
});
