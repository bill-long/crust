import { type Accessor, createRoot, createSignal, type Setter } from "solid-js";
import { vi } from "vitest";
import type { CallSessionApi } from "./callSessionStore";
import type {
	LivekitConnectionStatus,
	LivekitRoomApi,
	RtcParticipant,
	VideoTrackEntry,
} from "./useLivekitRoom";
import type { RtcSessionApi, RtcStatus } from "./useRtcSession";

/**
 * Test-only fake `CallSessionApi` builder. Every accessor is a real Solid
 * signal so tests can drive state transitions reactively. Action methods
 * are `vi.fn()` so tests can assert call counts / arguments.
 *
 * Usage:
 *
 *   const fake = makeFakeCallSession();
 *   publishCallSession(fake.api);
 *   // ... render component, then drive state:
 *   fake.setRtcStatus("joining");
 *
 * The exported `api` satisfies `CallSessionApi` so any structural drift in
 * the real interface is caught at compile time.
 */

interface FakeCallSession {
	api: CallSessionApi;
	/** Disposes the underlying Solid root that owns this fake's signals.
	 * Tests should call this in `afterEach` to release the reactive
	 * graph so it doesn't accumulate across test runs. */
	dispose: () => void;

	setRoomName: Setter<string>;
	setRtcStatus: Setter<RtcStatus>;
	setRtcError: Setter<Error | null>;
	setRtcCanJoin: Setter<boolean>;
	setRtcJoinBlockReason: Setter<string | null>;
	setLivekitStatus: Setter<LivekitConnectionStatus>;
	setLivekitError: Setter<Error | null>;
	setLivekitParticipants: Setter<readonly RtcParticipant[]>;
	setLivekitAudioBlocked: Setter<boolean>;
	setLivekitLocalCamEnabled: Setter<boolean>;
	setLivekitLocalScreenShareEnabled: Setter<boolean>;
	setLivekitVideoTracks: Setter<ReadonlyMap<string, VideoTrackEntry>>;
	setLivekitScreenShareTracks: Setter<ReadonlyMap<string, VideoTrackEntry>>;
	setBridgeInitializing: Setter<boolean>;
	setBridgeInitError: Setter<Error | null>;
	setLeaving: Setter<boolean>;

	requestJoin: ReturnType<typeof vi.fn>;
	requestClose: ReturnType<typeof vi.fn>;
	requestLeave: ReturnType<typeof vi.fn>;
	rtcJoin: ReturnType<typeof vi.fn>;
	rtcLeave: ReturnType<typeof vi.fn>;
	livekitDisconnect: ReturnType<typeof vi.fn>;
	livekitResumeAudio: ReturnType<typeof vi.fn>;
	livekitSetLocalCamEnabled: ReturnType<typeof vi.fn>;
	livekitSetLocalScreenShareEnabled: ReturnType<typeof vi.fn>;
	livekitTeardownComplete: ReturnType<typeof vi.fn>;
}

interface MakeFakeOptions {
	roomId?: string;
	roomName?: string;
	instanceId?: number;
}

export function makeFakeCallSession(
	opts: MakeFakeOptions = {},
): FakeCallSession {
	let result!: Omit<FakeCallSession, "dispose">;
	const dispose = createRoot((d) => {
		result = makeFakeCallSessionImpl(opts);
		return d;
	});
	return { ...result, dispose };
}

function makeFakeCallSessionImpl(
	opts: MakeFakeOptions,
): Omit<FakeCallSession, "dispose"> {
	const [roomName, setRoomName] = createSignal(opts.roomName ?? "Test Room");
	const [rtcStatus, setRtcStatus] = createSignal<RtcStatus>("idle");
	const [rtcError, setRtcError] = createSignal<Error | null>(null);
	const [rtcCanJoin, setRtcCanJoin] = createSignal(true);
	const [rtcJoinBlockReason, setRtcJoinBlockReason] = createSignal<
		string | null
	>(null);
	const [livekitStatus, setLivekitStatus] =
		createSignal<LivekitConnectionStatus>("idle");
	const [livekitError, setLivekitError] = createSignal<Error | null>(null);
	const [livekitParticipants, setLivekitParticipants] = createSignal<
		readonly RtcParticipant[]
	>([]);
	const [livekitAudioBlocked, setLivekitAudioBlocked] = createSignal(false);
	const [livekitLocalCamEnabled, setLivekitLocalCamEnabled] =
		createSignal(false);
	const [livekitLocalScreenShareEnabled, setLivekitLocalScreenShareEnabled] =
		createSignal(false);
	const [livekitVideoTracks, setLivekitVideoTracks] = createSignal<
		ReadonlyMap<string, VideoTrackEntry>
	>(new Map());
	const [livekitScreenShareTracks, setLivekitScreenShareTracks] = createSignal<
		ReadonlyMap<string, VideoTrackEntry>
	>(new Map());
	const [bridgeInitializing, setBridgeInitializing] = createSignal(false);
	const [bridgeInitError, setBridgeInitError] = createSignal<Error | null>(
		null,
	);
	const [leaving, setLeaving] = createSignal(false);

	const requestJoin = vi.fn(async () => {});
	const requestClose = vi.fn();
	const requestLeave = vi.fn(async () => {});
	const rtcJoin = vi.fn(async () => {});
	const rtcLeave = vi.fn(async () => {});
	const livekitDisconnect = vi.fn(async () => {});
	const livekitResumeAudio = vi.fn(async () => {});
	const livekitSetLocalCamEnabled = vi.fn(async (_enabled: boolean) => {});
	const livekitSetLocalScreenShareEnabled = vi.fn(
		async (_enabled: boolean) => {},
	);
	const livekitTeardownComplete = vi.fn(async () => {});

	const rtc = {
		status: rtcStatus,
		memberships: () => [],
		error: rtcError,
		canJoin: rtcCanJoin,
		joinBlockReason: rtcJoinBlockReason,
		activeFocus: () => null,
		fociReady: Promise.resolve(),
		join: rtcJoin,
		leave: rtcLeave,
	} satisfies RtcSessionApi;

	const livekit: LivekitRoomApi = {
		status: livekitStatus,
		error: livekitError,
		participants: livekitParticipants,
		localCamEnabled: livekitLocalCamEnabled,
		setLocalCamEnabled: livekitSetLocalCamEnabled,
		localScreenShareEnabled: livekitLocalScreenShareEnabled,
		setLocalScreenShareEnabled: livekitSetLocalScreenShareEnabled,
		screenShareSupported: true,
		videoTracks: livekitVideoTracks,
		screenShareTracks: livekitScreenShareTracks,
		disconnect: livekitDisconnect,
		audioBlocked: livekitAudioBlocked,
		resumeAudio: livekitResumeAudio,
		teardownComplete: livekitTeardownComplete,
	};

	const api = {
		instanceId: opts.instanceId ?? 1,
		roomId: opts.roomId ?? "!room:example.com",
		roomName: roomName as Accessor<string>,
		rtc,
		livekit,
		bridgeInitializing,
		bridgeInitError,
		leaving,
		requestJoin,
		requestClose,
		requestLeave,
	} satisfies CallSessionApi;

	return {
		api,
		setRoomName,
		setRtcStatus,
		setRtcError,
		setRtcCanJoin,
		setRtcJoinBlockReason,
		setLivekitStatus,
		setLivekitError,
		setLivekitParticipants,
		setLivekitAudioBlocked,
		setLivekitLocalCamEnabled,
		setLivekitLocalScreenShareEnabled,
		setLivekitVideoTracks,
		setLivekitScreenShareTracks,
		setBridgeInitializing,
		setBridgeInitError,
		setLeaving,
		requestJoin,
		requestClose,
		requestLeave,
		rtcJoin,
		rtcLeave,
		livekitDisconnect,
		livekitResumeAudio,
		livekitSetLocalCamEnabled,
		livekitSetLocalScreenShareEnabled,
		livekitTeardownComplete,
	};
}
