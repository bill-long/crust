import { renderHook } from "@solidjs/testing-library";
import type {
	CallMembership,
	LivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc";
import { createEffect, createRoot, createSignal } from "solid-js";
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
			Source: {
				Camera: "camera",
				Microphone: "microphone",
				ScreenShare: "screen_share",
			},
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
		isScreenShareEnabled: boolean;
		setMicrophoneEnabled: ReturnType<typeof vi.fn>;
		setCameraEnabled: ReturnType<typeof vi.fn>;
		setScreenShareEnabled: ReturnType<typeof vi.fn>;
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
		isScreenShareEnabled: false,
		setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
			if (opts?.enableMicImpl) await opts.enableMicImpl();
			localParticipant.isMicrophoneEnabled = enabled;
		}),
		setCameraEnabled: vi.fn(async (enabled: boolean) => {
			localParticipant.isCameraEnabled = enabled;
		}),
		setScreenShareEnabled: vi.fn(async (enabled: boolean) => {
			localParticipant.isScreenShareEnabled = enabled;
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
		mxcUrlToHttp: ReturnType<typeof vi.fn>;
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
			mxcUrlToHttp: vi.fn(
				(mxc: string, w?: number, h?: number) =>
					`https://media.example.com/${mxc.replace("mxc://", "")}?w=${w}&h=${h}`,
			),
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
	// jsdom has no navigator.mediaDevices; provide getDisplayMedia so the
	// screen-share feature-detect (`screenShareSupported`) is true by default.
	// The "unsupported" test deletes it before rendering.
	Object.defineProperty(navigator, "mediaDevices", {
		value: { getDisplayMedia: vi.fn(async () => ({})) },
		configurable: true,
		writable: true,
	});
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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

	it("reconciles mic publish state when micEnabled() flips", async () => {
		const fakeRoom = createFakeRoom();
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const [mic, setMic] = createSignal(true);
		const { result } = renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				micEnabled: mic,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		// Publish-time honoured the initial true.
		expect(fakeRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
			true,
		);
		fakeRoom.localParticipant.setMicrophoneEnabled.mockClear();
		// Simulate the SDK reflecting the publish actually went live.
		fakeRoom.localParticipant.isMicrophoneEnabled = true;

		setMic(false);
		await waitFor(
			() =>
				fakeRoom.localParticipant.setMicrophoneEnabled.mock.calls.length > 0,
		);
		expect(fakeRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
			false,
		);
		fakeRoom.localParticipant.isMicrophoneEnabled = false;
		fakeRoom.localParticipant.setMicrophoneEnabled.mockClear();

		setMic(true);
		await waitFor(
			() =>
				fakeRoom.localParticipant.setMicrophoneEnabled.mock.calls.length > 0,
		);
		expect(fakeRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(
			true,
		);
	});

	it("catches mic intent flip during publish-time setMicrophoneEnabled", async () => {
		let releasePublish: (() => void) | undefined;
		const fakeRoom = createFakeRoom({
			enableMicImpl: () =>
				new Promise<void>((res) => {
					releasePublish = res;
				}),
		});
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		const [mic, setMic] = createSignal(true);
		renderHook(() =>
			useLivekitRoom({
				client: client as never,
				focus: () => livekitFocus,
				enabled: () => true,
				memberships: () => [],
				audioDeviceId: () => "",
				videoDeviceId: () => "",
				micEnabled: mic,
				loadLivekit,
			}),
		);
		// Wait for publish-time setMicrophoneEnabled to be issued (and held).
		await waitFor(
			() =>
				fakeRoom.localParticipant.setMicrophoneEnabled.mock.calls.length === 1,
		);
		// Flip intent while the publish call is mid-flight.
		setMic(false);
		await flush();
		// The reconcile effect must NOT race a concurrent SDK call while the
		// publish-time call is still pending — `micOpPending` blocks it.
		expect(
			fakeRoom.localParticipant.setMicrophoneEnabled.mock.calls.length,
		).toBe(1);
		// Release the publish-time call (settles isMicrophoneEnabled = true).
		releasePublish?.();
		// Post-publish trampoline must reconcile to the latest intent (false).
		await waitFor(
			() =>
				fakeRoom.localParticipant.setMicrophoneEnabled.mock.calls.length >= 2,
		);
		expect(
			fakeRoom.localParticipant.setMicrophoneEnabled,
		).toHaveBeenLastCalledWith(false);
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remote = result.participants().find((p) => !p.isLocal);
		expect(remote?.displayName).toBe("Bob");
	});

	it("resolves participant avatar url via membership rtcBackendIdentity", async () => {
		const fakeRoom = createFakeRoom();
		fakeRoom.remoteParticipants.set("remote-bid", {
			identity: "remote-bid",
			audioTrackPublications: new Map(),
			videoTrackPublications: new Map(),
		});
		roomFactory.current = () => fakeRoom;
		const { client } = createClient();
		client.getUser.mockImplementation((userId: string) =>
			userId === "@bob:example.com"
				? { displayName: "Bob", avatarUrl: "mxc://example.com/bob" }
				: null,
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remote = result.participants().find((p) => !p.isLocal);
		expect(remote?.avatarUrl).toContain("example.com/bob");
		expect(remote?.avatarUrlLarge).toContain("example.com/bob");
		// Compact surfaces (PiP panel rows) use the small 96px crop; the full
		// call tile renders the avatar large and scales it, so a separate
		// high-res 448px crop avoids upscaling blur.
		expect(client.mxcUrlToHttp).toHaveBeenCalledWith(
			"mxc://example.com/bob",
			96,
			96,
			"crop",
		);
		expect(client.mxcUrlToHttp).toHaveBeenCalledWith(
			"mxc://example.com/bob",
			448,
			448,
			"crop",
		);
	});

	it("resolves a null avatar url when the member has no avatar", async () => {
		const fakeRoom = createFakeRoom();
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remote = result.participants().find((p) => !p.isLocal);
		expect(remote?.avatarUrl).toBeNull();
		expect(client.mxcUrlToHttp).not.toHaveBeenCalled();
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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

	it("muting the local camera reverts the tile to the avatar (LiveKit mutes, not unpublishes)", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.setLocalCamEnabled(true);
		const localTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		const camPub = {
			source: "camera",
			videoTrack: localTrack,
			isMuted: false,
			trackSid: "pub-local-cam",
		};
		fakeRoom.localParticipant.videoTrackPublications.set(
			"pub-local-cam",
			camPub,
		);
		fakeRoom.emit("localTrackPublished");
		expect(result.videoTracks().has("local-id")).toBe(true);

		// Stop camera: LiveKit MUTES the publication (does not unpublish) and
		// fires TrackMuted — the tile must drop the (frozen) video for the avatar.
		camPub.isMuted = true;
		fakeRoom.emit("trackMuted", camPub, { identity: "local-id" });
		expect(result.videoTracks().has("local-id")).toBe(false);

		// Start camera again: unmute re-adds the tile via TrackUnmuted.
		camPub.isMuted = false;
		fakeRoom.emit("trackUnmuted", camPub, { identity: "local-id" });
		expect(result.videoTracks().get("local-id")?.track).toBe(localTrack);
	});

	it("muting/unmuting a remote camera removes/re-adds its videoTracks entry", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const remoteTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		const remotePub = {
			source: "camera",
			trackSid: "remote-sid",
			videoTrack: remoteTrack,
			isMuted: false,
		};
		fakeRoom.emit("trackSubscribed", remoteTrack, remotePub, {
			identity: "remote-1",
		});
		expect(result.videoTracks().has("remote-1")).toBe(true);

		remotePub.isMuted = true;
		fakeRoom.emit("trackMuted", remotePub, { identity: "remote-1" });
		expect(result.videoTracks().has("remote-1")).toBe(false);

		remotePub.isMuted = false;
		fakeRoom.emit("trackUnmuted", remotePub, { identity: "remote-1" });
		expect(result.videoTracks().get("remote-1")?.track).toBe(remoteTrack);
	});

	it("skips a remote camera that is already muted at subscribe time, then adds it on unmute", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		// Remote joined with camera off: the track is subscribed but muted, so no
		// tile video should be added (it would otherwise show a black frame).
		const remoteTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		const remotePub = {
			source: "camera",
			trackSid: "remote-sid",
			videoTrack: remoteTrack,
			isMuted: true,
		};
		fakeRoom.emit("trackSubscribed", remoteTrack, remotePub, {
			identity: "remote-1",
		});
		expect(result.videoTracks().has("remote-1")).toBe(false);

		// They turn their camera on → TrackUnmuted adds the tile.
		remotePub.isMuted = false;
		fakeRoom.emit("trackUnmuted", remotePub, { identity: "remote-1" });
		expect(result.videoTracks().get("remote-1")?.track).toBe(remoteTrack);
	});

	it("setLocalScreenShareEnabled(true) calls setScreenShareEnabled and populates screenShareTracks for the local identity", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(result.localScreenShareEnabled()).toBe(false);
		await result.setLocalScreenShareEnabled(true);
		// No `screenShareQuality` option is passed by this harness, so the hook
		// falls back to the default (1080p30) capture constraint + encoding.
		expect(
			fakeRoom.localParticipant.setScreenShareEnabled,
		).toHaveBeenCalledWith(
			true,
			{
				audio: true,
				resolution: { width: 1920, height: 1080, frameRate: 30 },
				contentHint: "motion",
			},
			{
				// 1080p30 ceiling raised 5M -> 8M so motion isn't starved.
				screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 30 },
				videoCodec: "vp9",
				scalabilityMode: "L1T3",
				simulcast: false,
				degradationPreference: "maintain-framerate",
			},
		);
		expect(result.localScreenShareEnabled()).toBe(true);
		// LiveKit publishes the local screen-share track; reconcile puts it in
		// screenShareTracks (not videoTracks) under the local identity.
		const localTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		fakeRoom.localParticipant.videoTrackPublications.set("pub-local-share", {
			source: "screen_share",
			videoTrack: localTrack,
			isSubscribed: true,
			trackSid: "pub-local-share",
		});
		fakeRoom.emit("localTrackPublished");
		expect(result.screenShareTracks().get("local-id")?.track).toBe(localTrack);
		expect(result.videoTracks().has("local-id")).toBe(false);
	});

	it("setLocalScreenShareEnabled passes the selected quality's capture + encoding (1080p60 needs the 60fps capture override)", async () => {
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
				micEnabled: () => true,
				screenShareQuality: () => "1080p60",
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.setLocalScreenShareEnabled(true);
		expect(
			fakeRoom.localParticipant.setScreenShareEnabled,
		).toHaveBeenCalledWith(
			true,
			// frameRate: 60 in the capture constraint is essential — LiveKit's
			// default screen-capture caps at 30fps, so the encoding alone wouldn't
			// reach 60.
			{
				audio: true,
				resolution: { width: 1920, height: 1080, frameRate: 60 },
				contentHint: "motion",
			},
			{
				screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
				videoCodec: "vp9",
				scalabilityMode: "L1T3",
				simulcast: false,
				degradationPreference: "maintain-framerate",
			},
		);
	});

	it("native Stop sharing (LocalTrackUnpublished with no share pub) syncs localScreenShareEnabled back to false", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.setLocalScreenShareEnabled(true);
		const localTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		fakeRoom.localParticipant.videoTrackPublications.set("pub-local-share", {
			source: "screen_share",
			videoTrack: localTrack,
			isSubscribed: true,
			trackSid: "pub-local-share",
		});
		fakeRoom.emit("localTrackPublished");
		expect(result.screenShareTracks().has("local-id")).toBe(true);
		expect(result.localScreenShareEnabled()).toBe(true);

		// User clicks the browser's native "Stop sharing": LiveKit unpublishes
		// and isScreenShareEnabled goes false WITHOUT going through our toggle.
		fakeRoom.localParticipant.isScreenShareEnabled = false;
		fakeRoom.localParticipant.videoTrackPublications.clear();
		fakeRoom.emit("localTrackUnpublished");
		expect(result.localScreenShareEnabled()).toBe(false);
		expect(result.screenShareTracks().has("local-id")).toBe(false);
	});

	it("setLocalScreenShareEnabled reverts the optimistic flag and surfaces error when the picker is cancelled", async () => {
		const fakeRoom = createFakeRoom();
		fakeRoom.localParticipant.setScreenShareEnabled.mockImplementation(
			async () => {
				throw new Error("Permission denied");
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		await result.setLocalScreenShareEnabled(true);
		expect(result.localScreenShareEnabled()).toBe(false);
		expect(result.error()?.message).toContain("Permission denied");
	});

	it("reports screenShareSupported=false and fails closed when getDisplayMedia is absent", async () => {
		// Simulate a browser without display capture (most mobile browsers).
		Object.defineProperty(navigator, "mediaDevices", {
			value: {},
			configurable: true,
			writable: true,
		});
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(result.screenShareSupported).toBe(false);
		await result.setLocalScreenShareEnabled(true);
		expect(
			fakeRoom.localParticipant.setScreenShareEnabled,
		).not.toHaveBeenCalled();
		expect(result.localScreenShareEnabled()).toBe(false);
		expect(result.error()?.message).toContain("supported");
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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

	it("remote screen-share TrackSubscribed populates screenShareTracks (not videoTracks); TrackUnsubscribed removes it", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const shareTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		const sharePub = { source: "screen_share", trackSid: "ss-sid" };
		fakeRoom.emit("trackSubscribed", shareTrack, sharePub, {
			identity: "remote-1",
		});
		// Screen-share lands in its own map, never the camera map.
		expect(result.screenShareTracks().get("remote-1")?.track).toBe(shareTrack);
		expect(result.screenShareTracks().get("remote-1")?.sid).toBe("ss-sid");
		expect(result.videoTracks().has("remote-1")).toBe(false);

		fakeRoom.emit("trackUnsubscribed", shareTrack, sharePub, {
			identity: "remote-1",
		});
		expect(result.screenShareTracks().has("remote-1")).toBe(false);
	});

	it("a participant can have a camera and screen-share entry at the same time", async () => {
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		const camTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		const shareTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		fakeRoom.emit(
			"trackSubscribed",
			camTrack,
			{ source: "camera", trackSid: "cam-sid" },
			{ identity: "remote-1" },
		);
		fakeRoom.emit(
			"trackSubscribed",
			shareTrack,
			{ source: "screen_share", trackSid: "ss-sid" },
			{ identity: "remote-1" },
		);
		expect(result.videoTracks().get("remote-1")?.track).toBe(camTrack);
		expect(result.screenShareTracks().get("remote-1")?.track).toBe(shareTrack);

		// Disconnect purges BOTH the camera and screen-share entries.
		fakeRoom.emit("participantDisconnected", { identity: "remote-1" });
		expect(result.videoTracks().has("remote-1")).toBe(false);
		expect(result.screenShareTracks().has("remote-1")).toBe(false);
	});

	it("scans already-subscribed remote screen-share publications on connect", async () => {
		const fakeRoom = createFakeRoom();
		const shareTrack = { kind: "video", attach: vi.fn(), detach: vi.fn() };
		// A remote participant already sharing their screen before our
		// TrackSubscribed listener attaches (call already in progress).
		fakeRoom.remoteParticipants.set("remote-bid", {
			identity: "remote-bid",
			audioTrackPublications: new Map(),
			videoTrackPublications: new Map([
				[
					"ss-pub",
					{
						source: "screen_share",
						videoTrack: shareTrack,
						isSubscribed: true,
						trackSid: "ss-pub",
					},
				],
			]),
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
				micEnabled: () => true,
				loadLivekit,
			}),
		);
		await waitFor(() => result.status() === "connected");
		expect(result.screenShareTracks().get("remote-bid")?.track).toBe(
			shareTrack,
		);
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
				micEnabled: () => true,
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
					micEnabled: () => true,
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
					micEnabled: () => true,
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
					micEnabled: () => true,
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
					micEnabled: () => true,
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
					micEnabled: () => true,
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
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");
			expect(fakeRoom.setE2EEEnabled).not.toHaveBeenCalled();
			const opts = roomFactory.lastOptions as { e2ee?: unknown };
			expect(opts?.e2ee).toBeUndefined();
		});
	});

	describe("Phase 2 race-ordering (issue #125)", () => {
		// Distinct LivekitTransports — focus-change branch in
		// useLivekitRoom.ts:924-928 compares `livekit_service_url`, not
		// reference, so every focus in a sequenced test needs its own URL.
		const focusA: LivekitTransport = {
			type: "livekit",
			livekit_service_url: "https://sfu-a.example.com",
			livekit_alias: "!room:example.com",
		};
		const focusB: LivekitTransport = {
			type: "livekit",
			livekit_service_url: "https://sfu-b.example.com",
			livekit_alias: "!room:example.com",
		};
		const focusC: LivekitTransport = {
			type: "livekit",
			livekit_service_url: "https://sfu-c.example.com",
			livekit_alias: "!room:example.com",
		};

		// Queue a deterministic sequence of fake rooms per connect attempt
		// so we can verify only the expected attempts construct a Room.
		function queueRooms(...fakes: FakeRoom[]): void {
			const queue = [...fakes];
			roomFactory.current = (): FakeRoom => {
				const next = queue.shift();
				if (!next) throw new Error("queueRooms exhausted");
				return next;
			};
		}

		// Helper for a room whose disconnect() is held until released.
		// Returns the room and its release fn. Disconnect resolves WITHOUT
		// emitting "disconnected" so the test owns event timing — the
		// production paths exercised here all null `room` synchronously
		// before awaiting r.disconnect(), so the Disconnected handler is
		// `ifLive`-gated away. Emitting it would double-bump `attempt`
		// and confuse the epoch assertions.
		function heldDisconnectRoom(): { room: FakeRoom; release: () => void } {
			const room = createFakeRoom();
			let release: () => void = () => {};
			const gate = new Promise<void>((res) => {
				release = res;
			});
			room.disconnect.mockImplementation(async () => {
				await gate;
			});
			return { room, release };
		}

		it("focus A→B→C in rapid succession: only the final connect wins (B never constructed)", async () => {
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			const fakeC = createFakeRoom();
			queueRooms(fakeA, fakeC);
			const { client } = createClient();
			const [focus, setFocus] = createSignal<LivekitTransport | null>(focusA);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus,
					enabled: () => true,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");
			expect(roomFactory.callCount).toBe(1);

			setFocus(focusB);
			setFocus(focusC);
			releaseA();
			await waitFor(
				() => roomFactory.callCount === 2 && result.status() === "connected",
			);
			expect(roomFactory.callCount).toBe(2);
			expect(fakeC.connect).toHaveBeenCalledTimes(1);
			expect(jwtMock).toHaveBeenCalledTimes(2);
			expect(jwtMock).toHaveBeenNthCalledWith(
				2,
				focusC,
				expect.anything(),
				"DEVABC123",
			);
		});

		it("leave during focus change: explicit-disconnect refcount blocks the focus branch from reconnecting", async () => {
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			// Empty queue after A — any erroneous reconnect throws loudly.
			queueRooms(fakeA);
			const { client } = createClient();
			const [focus, setFocus] = createSignal<LivekitTransport | null>(focusA);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus,
					enabled: () => true,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");

			// Kick off explicit disconnect FIRST so the refcount is held
			// across teardown's await. Then race a focus change in while
			// the teardown is still in flight: the focus branch must see
			// `explicitDisconnect() === true` and bail early (the
			// disconnect()-bumped epoch alone is not sufficient — by the
			// time the focus tick fires here, that epoch is the current
			// epoch, so a missing refcount guard would let the focus
			// branch enter its `if (room || status === "disconnecting")`
			// arm, ++attempt to a new epoch, and chain a fresh doConnect).
			const disconnectPromise = result.disconnect();
			setFocus(focusB);
			releaseA();
			await disconnectPromise;
			// Drain microtasks so that if the explicit-disconnect refcount
			// guard regressed, a leaked focus-branch `.then` would have
			// chained doConnect(B) → loadLivekit → new MockRoom (which
			// throws on the empty queue and bumps `roomFactory.callCount`
			// in the constructor's first line). Without these flushes the
			// assertion races the queued microtasks and false-passes.
			await flush();
			await flush();
			await flush();
			expect(roomFactory.callCount).toBe(1);
			expect(result.status()).toBe("idle");
		});

		it("disable during focus change: disable branch's epoch bump invalidates the queued reconnect", async () => {
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			queueRooms(fakeA);
			const { client } = createClient();
			const [focus, setFocus] = createSignal<LivekitTransport | null>(focusA);
			const [enabled, setEnabled] = createSignal(true);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");

			setFocus(focusB);
			setEnabled(false);
			releaseA();
			await waitFor(() => result.status() === "idle");
			expect(roomFactory.callCount).toBe(1);
		});

		it("dispose during teardown: post-await .then bails on disposed flag (no setStatus('idle') after unmount)", async () => {
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			queueRooms(fakeA);
			const { client } = createClient();
			const [enabled, setEnabled] = createSignal(true);
			let api: ReturnType<typeof useLivekitRoom> | null = null;
			const dispose = createRoot((d) => {
				api = useLivekitRoom({
					client: client as never,
					focus: () => focusA,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				});
				return d;
			});
			// biome-ignore lint/style/noNonNullAssertion: assigned in createRoot
			await waitFor(() => api!.status() === "connected");

			setEnabled(false);
			// biome-ignore lint/style/noNonNullAssertion: assigned in createRoot
			expect(api!.status()).toBe("disconnecting");
			dispose();
			releaseA();
			await flush();
			await flush();
			// Disposed guard held — the disable branch's post-await
			// setStatus("idle") side effect was suppressed.
			// biome-ignore lint/style/noNonNullAssertion: assigned in createRoot
			expect(api!.status()).toBe("disconnecting");
			expect(fakeA.disconnect).toHaveBeenCalledTimes(1);
		});

		it("concurrent disconnect() calls: shared teardown chain; racing focus change does not leak a reconnect", async () => {
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			queueRooms(fakeA);
			const { client } = createClient();
			const [focus, setFocus] = createSignal<LivekitTransport | null>(focusA);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus,
					enabled: () => true,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");

			const d1 = result.disconnect();
			const d2 = result.disconnect();
			setFocus(focusB);
			releaseA();
			await Promise.all([d1, d2]);
			expect(fakeA.disconnect).toHaveBeenCalledTimes(1);
			expect(roomFactory.callCount).toBe(1);
			expect(result.status()).toBe("idle");
		});

		it("stale .then clobber: T1 must not setStatus('idle') after a newer T2 superseded it", async () => {
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			const fakeA2 = createFakeRoom();
			queueRooms(fakeA, fakeA2);
			const { client } = createClient();
			const [enabled, setEnabled] = createSignal(true);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => focusA,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			// Subscribe to every status change so we can prove T1's
			// stale `.then` (which would call `setStatus("idle")`
			// without the `epoch !== attempt` guard at
			// useLivekitRoom.ts:890) did not fire. Asserting only the
			// final status would not catch this: T2's doConnect would
			// overwrite back to "connected" regardless.
			const transitions: string[] = [];
			let stopRecording: () => void = () => {};
			createRoot((d) => {
				stopRecording = d;
				createEffect(() => {
					transitions.push(result.status());
				});
			});

			try {
				await waitFor(() => result.status() === "connected");
				// Reset history to just the post-stable-connected sequence.
				transitions.length = 0;

				setEnabled(false);
				expect(result.status()).toBe("disconnecting");
				// Re-enable while still "disconnecting" → focus-change branch
				// fires, bumps epoch, chains T2 + doConnect(A).
				setEnabled(true);
				releaseA();
				await waitFor(() => result.status() === "connected");
				expect(roomFactory.callCount).toBe(2);
				expect(fakeA2.connect).toHaveBeenCalledTimes(1);
				// Critical: no stale "idle" leak between the disable-branch's
				// "disconnecting" and the reconnect's "connected". T1's
				// post-await callback bailed on the epoch guard.
				expect(transitions).toEqual([
					"disconnecting",
					"connecting",
					"connected",
				]);
			} finally {
				stopRecording();
			}
		});

		it("late TrackMuted from a mid-teardown setMicrophoneEnabled does not repopulate participants (ifLive guard holds)", async () => {
			// The real Phase 2 invariant: even if an SDK event fires
			// AFTER teardown's resetCallDerivedState has cleared the
			// participants list, the ifLive-wrapped handler must bail on
			// stale myAttempt and NOT re-run snapshotParticipants on the
			// dying room. We emit `trackMuted` explicitly AFTER awaiting
			// teardown so the test can't false-pass via resetCallDerived-
			// State having the last word.
			const { room: fakeA, release: releaseA } = heldDisconnectRoom();
			// Seed a remote participant so a snapshot call would actually
			// re-publish a non-empty list (the local id is also included).
			fakeA.remoteParticipants.set("remote-bid", {
				identity: "remote-bid",
				audioTrackPublications: new Map(),
				videoTrackPublications: new Map(),
			});
			queueRooms(fakeA);
			const { client } = createClient();
			const [enabled, setEnabled] = createSignal(true);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus: () => focusA,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await waitFor(() => result.status() === "connected");
			expect(result.participants().length).toBe(2);

			// Disable bumps `attempt` synchronously, queues teardown.
			setEnabled(false);
			// Release teardown's r.disconnect so resetCallDerivedState
			// runs and participants is wiped to [].
			releaseA();
			await waitFor(() => result.status() === "idle");
			expect(result.participants()).toEqual([]);

			// NOW fire a late TrackMuted as if the SDK delivered an event
			// after our local teardown. The ifLive handler captured
			// `myAttempt` at register-time; the disable branch's
			// ++attempt invalidated it, so this emit must NOT cause
			// snapshotParticipants to re-publish the seeded remote.
			fakeA.emit("trackMuted");
			expect(result.participants()).toEqual([]);
		});

		it("disconnect() while idle leaves the hook functional and constructs no rooms", async () => {
			const fakeA = createFakeRoom();
			queueRooms(fakeA);
			const { client } = createClient();
			const [focus, setFocus] = createSignal<LivekitTransport | null>(focusA);
			const [enabled, setEnabled] = createSignal(false);
			const { result } = renderHook(() =>
				useLivekitRoom({
					client: client as never,
					focus,
					enabled,
					memberships: () => [],
					audioDeviceId: () => "",
					videoDeviceId: () => "",
					micEnabled: () => true,
					loadLivekit,
				}),
			);
			await flush();
			expect(result.status()).toBe("idle");
			expect(roomFactory.callCount).toBe(0);
			// disconnect-while-idle: the implementation bumps attempt and
			// depth BEFORE the idle short-circuit (see useLivekitRoom.ts
			// disconnect()), so a racing focus tick scheduled in the same
			// Solid batch sees explicitDisconnect()===true. We observe
			// externally: no rooms are constructed, and the hook is still
			// healthy afterward (re-enable connects normally).
			const p = result.disconnect();
			setFocus(focusB);
			await p;
			expect(result.status()).toBe("idle");
			expect(roomFactory.callCount).toBe(0);
			setEnabled(true);
			await waitFor(() => result.status() === "connected");
			expect(roomFactory.callCount).toBe(1);
		});
	});
});
