import type {
	Room as LivekitRoom,
	LocalVideoTrack,
	RemoteAudioTrack,
	RemoteTrack,
	RemoteTrackPublication,
	RemoteVideoTrack,
} from "livekit-client";
import type { MatrixClient } from "matrix-js-sdk";
import type {
	CallMembership,
	LivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc";
import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import type { ScreenShareQuality } from "../../../../stores/settings";
import { fetchLivekitToken, LivekitJwtError } from "./fetchLivekitToken";
import { screenShareQualitySpec } from "./screenShareQuality";

export type LivekitConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "disconnecting"
	| "error";

export interface RtcParticipant {
	/** LiveKit participant.identity — opaque RTC backend id. */
	identity: string;
	/** Resolved Matrix display name (or userId, or identity as fallback). */
	displayName: string;
	/** Small (96px) avatar URL for compact surfaces (e.g. the PiP panel rows). */
	avatarUrl: string | null;
	/** Large (448px) avatar URL for the full call tile, which renders the
	 *  avatar large and scales it with the participant count. Null together
	 *  with `avatarUrl` (both derive from the same mxc). */
	avatarUrlLarge: string | null;
	/** True when LiveKit reports the participant in the active-speakers list. */
	isSpeaking: boolean;
	/** True when the participant has muted their microphone publication. */
	isMuted: boolean;
	/** True for the local participant. */
	isLocal: boolean;
}

export interface UseLivekitRoomOptions {
	client: MatrixClient;
	/** Active LiveKit transport to dial (or null = don't connect). */
	focus: Accessor<LivekitTransport | null>;
	/** When false, the hook will not connect (and will disconnect if connected). */
	enabled: Accessor<boolean>;
	/**
	 * Memberships from `useRtcSession` — used to map LiveKit identity →
	 * `rtcBackendIdentity` → Matrix userId for display-name resolution.
	 */
	memberships: Accessor<readonly CallMembership[]>;
	/** Microphone deviceId (empty string = system default). */
	audioDeviceId: Accessor<string>;
	/**
	 * Desired mic publish state — drives `setMicrophoneEnabled` via a
	 * single-flight reconcile loop (like `setLocalCamEnabled`). Honored
	 * at publish time on connect, and reconciled on every subsequent
	 * change. Source of truth lives in the voice store
	 * (`src/stores/voice.ts`); the LiveKit hook never mutates intent.
	 */
	micEnabled: Accessor<boolean>;
	/**
	 * Camera deviceId (empty string = system default). Applied at the next
	 * `setLocalCamEnabled(true)` — changing it mid-call does NOT restart an
	 * already-published camera (mirrors `audioDeviceId` semantics from
	 * Phase 2).
	 */
	videoDeviceId: Accessor<string>;
	/**
	 * Outgoing screen-share quality. Read at the moment a share starts (via
	 * `setLocalScreenShareEnabled(true)`) to pick the capture constraint +
	 * encoder ceiling — so changing it applies to the NEXT share, not one
	 * already in progress. Optional: omitted in tests, where it falls back to
	 * the default preset.
	 */
	screenShareQuality?: Accessor<ScreenShareQuality>;
	/**
	 * Loader for the livekit-client module. Defaults to a dynamic import so
	 * the LiveKit chunk is only fetched on Join. Tests inject a synchronous
	 * loader returning a mock module.
	 */
	loadLivekit?: () => Promise<typeof import("livekit-client")>;
	/**
	 * Phase 4 E2EE bridge context. When present and non-null, the hook
	 * passes `e2eeOptions` to the LiveKit `Room` constructor and
	 * `await room.setE2EEEnabled(true)` BEFORE `room.connect()` and
	 * before any track publish. Missing this ordering = dropped initial
	 * media frames on every encrypted join. When null/undefined, the
	 * hook builds an unencrypted Room (Phase 1/2 behaviour).
	 */
	e2ee?: Accessor<import("./rtcE2EEBridge").RtcE2EEContext | null>;
}

export interface VideoTrackEntry {
	/** LiveKit video track — local or remote. Attach to a `<video>` ref. */
	track: LocalVideoTrack | RemoteVideoTrack;
	/** Publication sid used for stale-event removal validation. */
	sid: string;
}

export interface LivekitRoomApi {
	status: Accessor<LivekitConnectionStatus>;
	error: Accessor<Error | null>;
	participants: Accessor<readonly RtcParticipant[]>;
	/**
	 * The user's *desired* camera publish state — flips immediately on
	 * `setLocalCamEnabled` so the button label is responsive, then a
	 * single-flight loop drives LiveKit to match. Reset to false on
	 * teardown so a recovery after a failed leave doesn't show
	 * camera-on with nothing actually published. The local preview tile
	 * mounts based on the per-participant `videoTracks` entry (which
	 * mirrors the SDK's actual publication state), not this signal — so a
	 * brief desired/actual mismatch during the in-flight reconcile loop
	 * is invisible to the user.
	 */
	localCamEnabled: Accessor<boolean>;
	/**
	 * Drive the local camera publish state. Optimistic: the signal flips
	 * immediately to reflect the latest user intent, then a single-flight
	 * loop reconciles LiveKit to the latest intent — rapid enable→disable
	 * settles on the last click rather than the order SDK promises resolve.
	 */
	setLocalCamEnabled: (enabled: boolean) => Promise<void>;
	/**
	 * The user's *desired* screen-share publish state — flips immediately on
	 * `setLocalScreenShareEnabled` for a responsive button, then a single-flight
	 * loop drives LiveKit to match. Also synced back to false when the
	 * publication ends (incl. the browser's native "Stop sharing"). Reset to
	 * false on teardown.
	 */
	localScreenShareEnabled: Accessor<boolean>;
	/**
	 * Drive the local screen-share publish state. `true` opens the browser's
	 * display picker (getDisplayMedia) and so must be called from a user
	 * gesture. Optimistic + single-flight, mirroring {@link setLocalCamEnabled}.
	 * No-ops (and surfaces an error) when {@link screenShareSupported} is false.
	 */
	setLocalScreenShareEnabled: (enabled: boolean) => Promise<void>;
	/**
	 * Whether `navigator.mediaDevices.getDisplayMedia` is present — a coarse
	 * capability check, false on most mobile browsers, so the UI hides the
	 * screen-share control rather than offering a dead button. Presence alone
	 * doesn't guarantee success: an insecure context or a user-cancelled picker
	 * still rejects at call time, which {@link setLocalScreenShareEnabled}
	 * handles by reverting the toggle + surfacing the error.
	 */
	screenShareSupported: boolean;
	/**
	 * Map of LiveKit participant identity → its camera VideoTrack entry.
	 * Only camera-source publications are stored; screen-share lives in the
	 * separate `screenShareTracks` map so a participant can show both at once.
	 * Tiles consume this and attach the track to their own `<video>` ref.
	 */
	videoTracks: Accessor<ReadonlyMap<string, VideoTrackEntry>>;
	/**
	 * Map of LiveKit participant identity → its screen-share VideoTrack entry.
	 * Populated for both remote `Track.Source.ScreenShare` publications and the
	 * local participant's own outgoing share, so the call UI can render a
	 * dedicated screen-share tile for each.
	 */
	screenShareTracks: Accessor<ReadonlyMap<string, VideoTrackEntry>>;
	/** Disconnects, stops local mic, detaches all audio. Idempotent. */
	disconnect: () => Promise<void>;
	/**
	 * True when autoplay was blocked; user gesture required.
	 * Calling `resumeAudio` will retry start.
	 */
	audioBlocked: Accessor<boolean>;
	resumeAudio: () => Promise<void>;
	/**
	 * Resolves when all queued teardowns — those started by an explicit
	 * `disconnect()`, by a focus/enabled change, or by component unmount
	 * — have run `r.disconnect()` AND released their E2EE binding.
	 * Resolves immediately if no teardown has ever been triggered.
	 *
	 * Every teardown invocation is chained through one shared promise so
	 * the latest call always waits for any prior in-flight teardown
	 * before starting. Exists so consumers that own the E2EE bridge can
	 * chain `ctx.dispose()` (which calls `worker.terminate()` on any
	 * binding still acquired via the safety-net sweep) behind the
	 * disconnect that is still using those workers. SolidJS's
	 * `onCleanup` chain runs synchronously and does NOT await returned
	 * promises, so the cross-hook LIFO claim alone cannot enforce
	 * "worker.terminate() AFTER r.disconnect()" on the unmount-while-
	 * joined path.
	 */
	teardownComplete: () => Promise<void>;
}

interface AttachedAudio {
	element: HTMLAudioElement;
	track: RemoteAudioTrack;
}

/**
 * Phase 2 LiveKit room wrapper for the native MatrixRTC client (#122).
 *
 * Dynamically imports `livekit-client` inside the connect path so neither
 * app boot nor opening the call overlay pulls the chunk — only the first
 * Join click does. Stays as a state machine keyed on (focus, enabled) so
 * Solid effect re-runs from mute/device toggles don't reconnect the room.
 *
 * Lifecycle: each connect attempt carries a monotonic `connectId`. After
 * every `await` we re-check `disposed` and the current id; stale attempts
 * stop tracks + disconnect immediately and never publish or update state.
 */
export function useLivekitRoom(opts: UseLivekitRoomOptions): LivekitRoomApi {
	const [status, setStatus] = createSignal<LivekitConnectionStatus>("idle");
	const [error, setError] = createSignal<Error | null>(null);
	const [participants, setParticipants] = createSignal<
		readonly RtcParticipant[]
	>([]);
	// Actual call-derived state: true while a camera publication is live.
	// NOT persisted across teardown — see `resetCallDerivedState()`.
	const [localCamEnabled, setLocalCamEnabledSignal] = createSignal(false);
	// Desired local screen-share state. Like `localCamEnabled`, flips
	// optimistically on intent and is reset on teardown. Unlike camera, it is
	// ALSO synced back to false when the publication disappears (see
	// `reconcileLocalScreenShare`) so the browser's native "Stop sharing" UI
	// keeps the button in sync.
	const [localScreenShareEnabled, setLocalScreenShareEnabledSignal] =
		createSignal(false);
	// Coarse capability check: is `getDisplayMedia` even present? It's absent on
	// most mobile browsers, so the UI hides the screen-share button. Presence
	// doesn't guarantee a successful capture (an insecure context or cancelled
	// picker still rejects at call time) — `setLocalScreenShareEnabled` handles
	// that by reverting the toggle and surfacing the error.
	const screenShareSupported =
		typeof navigator !== "undefined" &&
		typeof navigator.mediaDevices?.getDisplayMedia === "function";
	const [videoTracks, setVideoTracks] = createSignal<
		ReadonlyMap<string, VideoTrackEntry>
	>(new Map());
	const [screenShareTracks, setScreenShareTracks] = createSignal<
		ReadonlyMap<string, VideoTrackEntry>
	>(new Map());
	const [audioBlocked, setAudioBlocked] = createSignal(false);

	let room: LivekitRoom | null = null;
	// Per-Room E2EE binding kept alongside `room` so teardown can
	// release the keyProvider+worker AFTER `r.disconnect()` resolves —
	// LiveKit's E2EEManager attaches listeners on the keyProvider that
	// only fully detach once disconnect runs the close handlers.
	// Releasing the binding terminates that Room's dedicated worker and
	// drops the keyProvider from the relay's active-pump slot, so the
	// next `bindRoom()` (focus-change reconnect) starts clean.
	let binding: import("./rtcE2EEBridge").RtcE2EERoomBinding | null = null;
	// Tracks the most recently kicked-off teardown so external callers
	// (`CallSessionController`'s bridge-dispose onCleanup) can chain off it.
	// SolidJS `onCleanup` is synchronous and does not await returned
	// promises, so the cross-hook ordering of "release binding AFTER
	// room.disconnect resolves" cannot be enforced by LIFO alone on the
	// unmount-while-joined path. Exposing this promise lets the bridge
	// disposal defer `worker.terminate()` until our `teardown()` has
	// actually released the binding it acquired.
	let teardownPromise: Promise<void> = Promise.resolve();
	let attempt = 0;
	let disposed = false;
	// Number of explicit user-initiated `disconnect()` calls currently in
	// flight. Held > 0 for the duration of teardown so a concurrent focus/
	// membership update doesn't slip a reconnect into the focus-change
	// branch while the user is on their way out. The consumer
	// (`CallSessionController`) awaits `livekit.disconnect()` BEFORE `rtc.leave()`,
	// so `enabled` (gated on `rtc.status()==="joined"`) is still true during
	// the teardown — without this guard, focus churn can re-enter the call
	// after the user clicked Leave. A counter (not a boolean) so overlapping
	// disconnect calls don't clear the guard prematurely.
	let explicitDisconnectDepth = 0;
	// Camera-toggle single-flight: serializes overlapping setLocalCamEnabled
	// calls so the last user intent always wins, regardless of which SDK
	// promise resolves first. The outer call kicks off a reconcile loop and
	// sets this true; concurrent calls just update the desired-state signal
	// and let the loop pick it up on its next iteration.
	let cameraOpPending = false;
	// Screen-share-toggle single-flight: same pattern as `cameraOpPending`.
	let screenShareOpPending = false;
	// Mic-toggle single-flight: same pattern as `cameraOpPending`. Driven by
	// `createEffect` on `opts.micEnabled` (intent flips from the voice store
	// → reconcile loop drives LiveKit to match). The outer trigger kicks off
	// the loop and sets this true; concurrent triggers just rely on the loop
	// re-reading `opts.micEnabled()` on its next iteration.
	let micOpPending = false;
	const attachments = new Map<string, AttachedAudio>();
	// Mutable mirror of `videoTracks` for in-place updates; published as a
	// fresh Map to the signal whenever the contents change so Solid sees the
	// reference change.
	const videoTrackMap = new Map<string, VideoTrackEntry>();
	const publishVideoTracks = (): void => {
		setVideoTracks(new Map(videoTrackMap));
	};
	// Separate mirror for screen-share video, keyed by participant identity.
	// Kept apart from the camera map so a participant can have BOTH a camera
	// tile and a screen-share tile at once, and so screen-share rendering
	// (object-contain, dedicated tile) is independent of the camera path.
	const screenShareTrackMap = new Map<string, VideoTrackEntry>();
	const publishScreenShareTracks = (): void => {
		setScreenShareTracks(new Map(screenShareTrackMap));
	};
	// Cache of participant records keyed by identity. `snapshotParticipants`
	// reuses an existing object reference when none of its fields changed so
	// Solid `<For>` keeps the tile DOM (and any attached <video>) mounted
	// across active-speaker / mute events. Without this, every snapshot would
	// detach/reattach every video tile and adaptive-stream-pause/resume on
	// every speaking flip.
	const participantCache = new Map<string, RtcParticipant>();

	const detachAll = (): void => {
		for (const a of attachments.values()) {
			try {
				a.track.detach(a.element);
			} catch {
				/* ignore — element may already be detached */
			}
			a.element.remove();
		}
		attachments.clear();
	};

	const tryPlayAll = async (): Promise<boolean> => {
		// Returns true if every play() resolved; false if at least one was
		// blocked (e.g. autoplay policy). Each catch sets audioBlocked
		// directly so the UI flips even if the caller doesn't await us.
		// Captures `attempt` so a late-arriving rejection from a torn-down
		// session can't resurrect the banner after we've left the call.
		const myAttempt = attempt;
		const results = await Promise.allSettled(
			Array.from(attachments.values()).map((a) => a.element.play()),
		);
		if (disposed || myAttempt !== attempt) return false;
		let allOk = true;
		for (const r of results) {
			if (r.status === "rejected") {
				allOk = false;
				setAudioBlocked(true);
			}
		}
		return allOk;
	};

	const resolveIdentity = (
		identity: string,
	): {
		displayName: string;
		avatarUrl: string | null;
		avatarUrlLarge: string | null;
	} => {
		// LiveKit identity is the MatrixRTC backend identity. Map back through
		// the membership list to a userId, then resolve the member's display
		// name and avatar from a single profile lookup.
		const membership = opts
			.memberships()
			.find((m) => m.rtcBackendIdentity === identity);
		if (!membership) {
			return { displayName: identity, avatarUrl: null, avatarUrlLarge: null };
		}
		const user = opts.client.getUser(membership.userId);
		const mxc = user?.avatarUrl;
		return {
			displayName: user?.displayName ?? membership.userId,
			// Small crop for compact surfaces (PiP panel rows at ~32px).
			avatarUrl: mxc
				? (opts.client.mxcUrlToHttp(mxc, 96, 96, "crop") ?? null)
				: null,
			// The full call tile renders this avatar large (up to 14rem ≈ 224px
			// CSS, ~448px on a 2× display) and scales it with the participant
			// count, so request a high-res thumbnail to stay crisp instead of
			// upscaling the small one.
			//
			// 448 is a deliberate single size optimized for the common 1–2
			// person call on a HiDPI display (the case that looked blurriest).
			// We intentionally do NOT tier the size by participant count: that
			// would re-fetch every avatar whenever someone joins/leaves (the
			// tier — and thus the URL — would change), causing flicker and more
			// requests. On large calls the tiles shrink so the browser
			// downscales these crops; the only cost is a modest one-time
			// overfetch, which we accept in favour of never upscaling.
			avatarUrlLarge: mxc
				? (opts.client.mxcUrlToHttp(mxc, 448, 448, "crop") ?? null)
				: null,
		};
	};

	const snapshotParticipants = (r: LivekitRoom): void => {
		const speakingIds = new Set(r.activeSpeakers.map((p) => p.identity));
		const seen = new Set<string>();
		const reuseOrBuild = (
			identity: string,
			displayName: string,
			avatarUrl: string | null,
			avatarUrlLarge: string | null,
			isSpeaking: boolean,
			isMuted: boolean,
			isLocal: boolean,
		): RtcParticipant => {
			seen.add(identity);
			const prev = participantCache.get(identity);
			if (
				prev &&
				prev.displayName === displayName &&
				prev.avatarUrl === avatarUrl &&
				prev.avatarUrlLarge === avatarUrlLarge &&
				prev.isSpeaking === isSpeaking &&
				prev.isMuted === isMuted &&
				prev.isLocal === isLocal
			) {
				return prev;
			}
			const next: RtcParticipant = {
				identity,
				displayName,
				avatarUrl,
				avatarUrlLarge,
				isSpeaking,
				isMuted,
				isLocal,
			};
			participantCache.set(identity, next);
			return next;
		};
		const out: RtcParticipant[] = [];
		const localInfo = resolveIdentity(r.localParticipant.identity);
		out.push(
			reuseOrBuild(
				r.localParticipant.identity,
				localInfo.displayName,
				localInfo.avatarUrl,
				localInfo.avatarUrlLarge,
				speakingIds.has(r.localParticipant.identity),
				r.localParticipant.isMicrophoneEnabled === false,
				true,
			),
		);
		for (const p of r.remoteParticipants.values()) {
			const micPub = Array.from(p.audioTrackPublications.values()).find(
				(pub) => pub.source === "microphone",
			);
			const info = resolveIdentity(p.identity);
			out.push(
				reuseOrBuild(
					p.identity,
					info.displayName,
					info.avatarUrl,
					info.avatarUrlLarge,
					speakingIds.has(p.identity),
					micPub?.isMuted ?? true,
					false,
				),
			);
		}
		// Prune cache entries for participants who have disconnected so a
		// later rejoin with the same identity gets a fresh record (and so we
		// don't leak memory for a churning call).
		for (const id of [...participantCache.keys()]) {
			if (!seen.has(id)) participantCache.delete(id);
		}
		setParticipants(out);
	};

	const attachAudioTrack = (
		track: RemoteAudioTrack,
		publication: RemoteTrackPublication,
	): void => {
		const sid = publication.trackSid;
		if (attachments.has(sid)) return;
		const el = track.attach() as HTMLAudioElement;
		el.autoplay = true;
		// Hide but keep in DOM so the browser actually plays audio.
		el.style.display = "none";
		document.body.appendChild(el);
		attachments.set(sid, { element: el, track });
		const myAttempt = attempt;
		el.play().catch(() => {
			// Don't resurrect the banner if the session was torn down before
			// this rejection settled.
			if (disposed || myAttempt !== attempt) return;
			setAudioBlocked(true);
		});
	};

	const detachAudioTrack = (sid: string): void => {
		const a = attachments.get(sid);
		if (!a) return;
		try {
			a.track.detach(a.element);
		} catch {
			/* ignore */
		}
		a.element.remove();
		attachments.delete(sid);
	};

	// Insert / replace the video track for a participant identity in `map`.
	// Tile components own the <video> ref and call `track.attach(el)`
	// reactively when the map's signal updates — central DOM attachment is
	// intentionally NOT done here. Shared by the camera and screen-share maps.
	const upsertVideoEntry = (
		map: Map<string, VideoTrackEntry>,
		publish: () => void,
		identity: string,
		track: LocalVideoTrack | RemoteVideoTrack,
		sid: string,
	): void => {
		const prev = map.get(identity);
		if (prev && prev.sid === sid && prev.track === track) return;
		map.set(identity, { track, sid });
		publish();
	};

	// Remove the video track for an identity IF the stored entry matches the
	// publication that's going away. Late stale-publication events from a
	// device restart or transient unpublish/republish must NOT wipe a fresh
	// replacement that landed first. Shared by the camera and screen-share maps.
	const removeVideoEntryIfMatches = (
		map: Map<string, VideoTrackEntry>,
		publish: () => void,
		identity: string,
		sid: string,
	): void => {
		const prev = map.get(identity);
		if (!prev || prev.sid !== sid) return;
		map.delete(identity);
		publish();
	};

	const upsertVideoTrack = (
		identity: string,
		track: LocalVideoTrack | RemoteVideoTrack,
		sid: string,
	): void =>
		upsertVideoEntry(videoTrackMap, publishVideoTracks, identity, track, sid);
	const removeVideoTrackIfMatches = (identity: string, sid: string): void =>
		removeVideoEntryIfMatches(videoTrackMap, publishVideoTracks, identity, sid);
	const upsertScreenShareTrack = (
		identity: string,
		track: LocalVideoTrack | RemoteVideoTrack,
		sid: string,
	): void =>
		upsertVideoEntry(
			screenShareTrackMap,
			publishScreenShareTracks,
			identity,
			track,
			sid,
		);
	const removeScreenShareTrackIfMatches = (
		identity: string,
		sid: string,
	): void =>
		removeVideoEntryIfMatches(
			screenShareTrackMap,
			publishScreenShareTracks,
			identity,
			sid,
		);

	// Reconcile the local participant's camera publication into `videoTrackMap`
	// only. Called from `LocalTrackPublished` / `LocalTrackUnpublished` so the
	// local preview tile mounts/unmounts in sync with the SDK. Mute/unmute of an
	// already-published camera is handled separately by `reconcileCameraMute`
	// (wired to `TrackMuted` / `TrackUnmuted`).
	//
	// Treats a MUTED camera publication as "no video": LiveKit *mutes* (does not
	// unpublish) the camera on `setCameraEnabled(false)` — only screen share
	// unpublishes — so the publication and its `videoTrack` linger after Stop
	// camera. Without the mute check the tile would keep a frozen/black <video>
	// instead of reverting to the avatar.
	//
	// Intentionally does NOT touch `localCamEnabledSignal`. That signal
	// represents the user's *desired* state and is owned exclusively by
	// `setLocalCamEnabled` (for clicks) and `resetCallDerivedState` (for
	// teardown). If we wrote actual SDK state here, a `LocalTrackPublished`
	// event firing inside the loop's `setCameraEnabled` await — common with
	// LiveKit because publish events emit before the publish promise resolves
	// — would clobber a user's racing "off" intent, and the reconcile loop
	// would then see desired===actual and skip the disable. Keeping desired
	// and actual separate is what makes rapid enable→disable settle on the
	// last click.
	const reconcileLocalCamera = (r: LivekitRoom): void => {
		const camPub = Array.from(
			r.localParticipant.videoTrackPublications.values(),
		).find((pub) => pub.source === "camera");
		if (camPub?.videoTrack && !camPub.isMuted) {
			upsertVideoTrack(
				r.localParticipant.identity,
				camPub.videoTrack as LocalVideoTrack,
				camPub.trackSid,
			);
		} else {
			const prev = videoTrackMap.get(r.localParticipant.identity);
			if (prev) {
				videoTrackMap.delete(r.localParticipant.identity);
				publishVideoTracks();
			}
		}
	};

	// Show/hide a participant's camera tile when their camera publication is
	// muted/unmuted. Driven by `TrackMuted` / `TrackUnmuted` for BOTH local and
	// remote participants (the event carries the publication + participant), so
	// a stopped camera reverts to the avatar on every tile rather than freezing
	// on a black frame. Only the camera source toggles a video tile — screen
	// share can't be muted (it unpublishes), and mic mute is reflected by
	// `snapshotParticipants`, not here.
	const reconcileCameraMute = (
		publication: { source?: string; isMuted?: boolean; trackSid: string },
		videoTrack: LocalVideoTrack | RemoteVideoTrack | undefined,
		identity: string,
	): void => {
		if (publication.source !== "camera") return;
		if (publication.isMuted || !videoTrack) {
			removeVideoTrackIfMatches(identity, publication.trackSid);
		} else {
			upsertVideoTrack(identity, videoTrack, publication.trackSid);
		}
	};

	// Reconcile the local participant's screen-share publication into
	// `screenShareTrackMap` so the user sees their own outgoing share as a tile.
	// Called from `LocalTrackPublished` / `LocalTrackUnpublished`, mirroring
	// `reconcileLocalCamera`.
	//
	// DELIBERATE INVERSION of `reconcileLocalCamera`: when no screen-share
	// publication exists we ALSO write the desired-state signal to false. The
	// only ways a local screen share ends are the app's Stop button (desired
	// already false) or the browser's native "Stop sharing" UI (desired still
	// true). Syncing false here keeps the toggle correct for the native case and
	// prevents a later reconcile from re-prompting `getDisplayMedia`. This is
	// safe — unlike camera, screen share cannot be re-enabled without a fresh
	// user gesture, so there is no rapid enable→disable race to clobber.
	const reconcileLocalScreenShare = (r: LivekitRoom): void => {
		const sharePub = Array.from(
			r.localParticipant.videoTrackPublications.values(),
		).find((pub) => pub.source === "screen_share");
		if (sharePub?.videoTrack) {
			upsertScreenShareTrack(
				r.localParticipant.identity,
				sharePub.videoTrack as LocalVideoTrack,
				sharePub.trackSid,
			);
		} else {
			if (screenShareTrackMap.delete(r.localParticipant.identity)) {
				publishScreenShareTracks();
			}
			if (localScreenShareEnabled()) setLocalScreenShareEnabledSignal(false);
		}
	};

	// Reset call-derived UI state. Called from both `teardown()` (intentional
	// disconnects) and the `Disconnected` event handler (unsolicited drops)
	// so the participant list doesn't outlive the call. NOTE: mic intent
	// lives in the voice store (`src/stores/voice.ts`) since Phase 6 and is
	// intentionally NOT touched here — it's a user preference that carries
	// across calls and retries. `localCamEnabled` (desired-state intent) IS
	// reset here because Phase 3 does not auto-enable camera on reconnect,
	// so a leftover `true` would drive an unexpected publish on the next
	// connect.
	const resetCallDerivedState = (): void => {
		setParticipants([]);
		setAudioBlocked(false);
		participantCache.clear();
		if (videoTrackMap.size > 0) {
			videoTrackMap.clear();
			publishVideoTracks();
		}
		if (screenShareTrackMap.size > 0) {
			screenShareTrackMap.clear();
			publishScreenShareTracks();
		}
		setLocalCamEnabledSignal(false);
		// Same rationale as camera: clear screen-share intent so a leftover
		// `true` can't drive an unexpected publish on the next connect. Doubly
		// important here — re-capturing a display needs a fresh user gesture, so
		// a stale desired=true would just make the reconcile loop fail.
		setLocalScreenShareEnabledSignal(false);
	};

	const teardown = async (): Promise<void> => {
		detachAll();
		resetCallDerivedState();
		const r = room;
		room = null;
		const b = binding;
		binding = null;
		if (r) {
			try {
				await r.disconnect();
			} catch {
				/* swallow — best-effort */
			}
		}
		// Release AFTER disconnect resolves so the LiveKit close handlers
		// finish using the keyProvider/worker before we terminate them.
		b?.release();
	};

	// Wraps every `teardown()` invocation so `teardownComplete()` always
	// observes the LATEST in-flight teardown.
	//
	// Chains via `.then` rather than overwriting so an unmount that lands
	// while a focus-change or explicit-disconnect teardown is still
	// awaiting `r.disconnect()` waits for that original teardown to finish
	// FIRST (during which `room` and `binding` get nulled), then runs its
	// own no-op teardown second. Without the chain, the second
	// `teardown()` call would see `room === null` and resolve immediately,
	// causing `teardownComplete()` to release the bridge worker before
	// the first teardown's `await r.disconnect()` had finished using it.
	const trackTeardown = (): Promise<void> => {
		const next = teardownPromise.catch(() => undefined).then(() => teardown());
		teardownPromise = next;
		return next;
	};

	const doConnect = async (focus: LivekitTransport): Promise<void> => {
		const myAttempt = ++attempt;
		setError(null);
		setStatus("connecting");

		// Hoisted so the catch path can disconnect a Room that was created but
		// never assigned to module-level `room` (e.g., `r.connect()` rejected).
		// Without this, `teardown()` sees `room === null` and the orphaned Room
		// keeps its WebSocket/event listeners alive.
		let pendingRoom: LivekitRoom | null = null;
		// Same rationale for the E2EE binding: if we created one but
		// never promoted it alongside `room`, the catch path must
		// release it so the dedicated worker doesn't leak.
		let pendingBinding: import("./rtcE2EEBridge").RtcE2EERoomBinding | null =
			null;

		try {
			// Dynamic import: this is the moment LiveKit's chunk first loads.
			const lk = await (opts.loadLivekit ?? (() => import("livekit-client")))();
			if (disposed || myAttempt !== attempt) return;

			const openIdToken = await opts.client.getOpenIdToken();
			if (disposed || myAttempt !== attempt) return;

			// lk-jwt-service builds the LiveKit participant identity as
			// `<userId>:<deviceId>`. That string MUST match matrix-js-sdk's
			// `rtcBackendIdentity` (also `<userId>:<deviceId>`, computed
			// from `client.getDeviceId()` inside RTCEncryptionManager) so
			// the bridge's keyProvider entries line up with the identity
			// LiveKit assigns to participants. A missing device_id
			// silently breaks outbound E2EE for other participants — fail
			// fast instead.
			const deviceId = opts.client.getDeviceId();
			if (!deviceId) {
				throw new LivekitJwtError(
					"Matrix client has no device ID; cannot start RTC session",
				);
			}

			const { url, jwt } = await fetchLivekitToken(
				focus,
				openIdToken,
				deviceId,
			);
			if (disposed || myAttempt !== attempt) return;

			const e2eeCtx = opts.e2ee?.() ?? null;
			// Acquire a fresh per-Room binding BEFORE constructing the
			// `lk.Room`. The binding owns this Room's keyProvider+worker
			// pair so focus-change reconnects don't reuse a keyProvider
			// across Rooms (LiveKit's E2EEManager attaches non-cleanup
			// listeners on it, leaking per Room instance).
			const localBinding = e2eeCtx?.bindRoom() ?? null;
			pendingBinding = localBinding;
			const r = new lk.Room({
				adaptiveStream: true,
				dynacast: true,
				audioCaptureDefaults: {
					deviceId: opts.audioDeviceId() || undefined,
				},
				videoCaptureDefaults: {
					deviceId: opts.videoDeviceId() || undefined,
				},
				// Phase 4 invariant 1: E2EE options MUST be passed at
				// construction time so the Room sets up its E2EEManager
				// before any track publish path runs.
				e2ee: localBinding?.e2eeOptions,
			});
			// Track for catch-path cleanup: if `r.connect()` rejects (or
			// anything below throws), we still need to disconnect this
			// instance — `teardown()` only knows about module-level `room`.
			pendingRoom = r;
			// Register listeners BEFORE connect so we don't miss the initial
			// participant/track events for a call already in progress.
			// All handlers below capture `myAttempt` and bail when this
			// attempt is no longer live (stale connect superseded, or
			// teardown/dispose has begun). LiveKit can still emit events
			// from a disconnecting room, so without this guard a late
			// event could re-attach audio or re-populate participants
			// after `detachAll()` / `setParticipants([])`.
			const ifLive = <Args extends unknown[]>(
				fn: (...args: Args) => void,
			): ((...args: Args) => void) => {
				return (...args: Args): void => {
					if (disposed || myAttempt !== attempt) return;
					fn(...args);
				};
			};
			r.on(
				lk.RoomEvent.ParticipantConnected,
				ifLive(() => snapshotParticipants(r)),
			);
			r.on(
				lk.RoomEvent.ActiveSpeakersChanged,
				ifLive(() => snapshotParticipants(r)),
			);
			r.on(
				lk.RoomEvent.TrackMuted,
				ifLive(
					(
						publication: {
							source?: string;
							isMuted?: boolean;
							trackSid: string;
							videoTrack?: LocalVideoTrack | RemoteVideoTrack;
						},
						participant: { identity: string },
					) => {
						reconcileCameraMute(
							publication,
							publication.videoTrack,
							participant.identity,
						);
						snapshotParticipants(r);
					},
				),
			);
			r.on(
				lk.RoomEvent.TrackUnmuted,
				ifLive(
					(
						publication: {
							source?: string;
							isMuted?: boolean;
							trackSid: string;
							videoTrack?: LocalVideoTrack | RemoteVideoTrack;
						},
						participant: { identity: string },
					) => {
						reconcileCameraMute(
							publication,
							publication.videoTrack,
							participant.identity,
						);
						snapshotParticipants(r);
					},
				),
			);
			r.on(
				lk.RoomEvent.LocalTrackPublished,
				ifLive(() => {
					reconcileLocalCamera(r);
					reconcileLocalScreenShare(r);
					snapshotParticipants(r);
				}),
			);
			r.on(
				lk.RoomEvent.LocalTrackUnpublished,
				ifLive(() => {
					reconcileLocalCamera(r);
					reconcileLocalScreenShare(r);
					snapshotParticipants(r);
				}),
			);
			r.on(
				lk.RoomEvent.TrackSubscribed,
				ifLive(
					(
						track: RemoteTrack,
						publication: RemoteTrackPublication,
						participant: { identity: string },
					) => {
						if (track.kind === lk.Track.Kind.Audio) {
							// Covers both microphone and screen-share audio — the
							// hidden <audio> sink plays whatever source it carries.
							attachAudioTrack(track as RemoteAudioTrack, publication);
						} else if (track.kind === lk.Track.Kind.Video) {
							if (publication.source === lk.Track.Source.Camera) {
								// Skip a camera track that's already muted at subscribe
								// time — TrackUnmuted re-adds it. Avoids a black tile for a
								// remote who joined with their camera off.
								if (!publication.isMuted) {
									upsertVideoTrack(
										participant.identity,
										track as RemoteVideoTrack,
										publication.trackSid,
									);
								}
							} else if (publication.source === lk.Track.Source.ScreenShare) {
								upsertScreenShareTrack(
									participant.identity,
									track as RemoteVideoTrack,
									publication.trackSid,
								);
							}
						}
						snapshotParticipants(r);
					},
				),
			);
			r.on(
				lk.RoomEvent.TrackUnsubscribed,
				ifLive(
					(
						track: RemoteTrack,
						publication: RemoteTrackPublication,
						participant: { identity: string },
					) => {
						if (track.kind === lk.Track.Kind.Audio) {
							detachAudioTrack(publication.trackSid);
						} else if (track.kind === lk.Track.Kind.Video) {
							if (publication.source === lk.Track.Source.Camera) {
								removeVideoTrackIfMatches(
									participant.identity,
									publication.trackSid,
								);
							} else if (publication.source === lk.Track.Source.ScreenShare) {
								removeScreenShareTrackIfMatches(
									participant.identity,
									publication.trackSid,
								);
							}
						}
						snapshotParticipants(r);
					},
				),
			);
			r.on(
				lk.RoomEvent.ParticipantDisconnected,
				ifLive((participant: { identity: string }) => {
					// Clear any lingering video entry for the departed participant
					// regardless of trackSid. Stale TrackUnsubscribed events tied to
					// this participant may have been deferred by their disconnect.
					if (videoTrackMap.delete(participant.identity)) {
						publishVideoTracks();
					}
					if (screenShareTrackMap.delete(participant.identity)) {
						publishScreenShareTracks();
					}
					snapshotParticipants(r);
				}),
			);
			r.on(
				lk.RoomEvent.Disconnected,
				ifLive(() => {
					// Bump the attempt counter so any subsequent track/participant
					// events from this disconnecting room bail via `ifLive`. Without
					// this, late events could re-populate `participants` or re-attach
					// audio after we've reset state below.
					attempt++;
					detachAll();
					// Clear call-derived UI (participants, autoplay banner) so a
					// stale roster doesn't survive an unsolicited drop. The
					// module-level `room` handle is also cleared so a later
					// `reconcileMic` doesn't invoke SDK methods on a dead room.
					resetCallDerivedState();
					room = null;
					// Release the E2EE binding tied to THIS room so an
					// unsolicited Disconnected doesn't leak the keyProvider +
					// worker. Without this, a subsequent reconnect would
					// overwrite `binding` and the old worker would never get
					// terminated. Safe because `binding.release()` is idempotent
					// and we just cleared `room`, so `teardown()`'s later call
					// is a no-op.
					binding?.release();
					binding = null;
					// Preserve terminal/intentional states so an unsolicited
					// Disconnected event doesn't clobber the user-visible error
					// or override an in-flight explicit disconnect.
					const s = status();
					if (s !== "error" && s !== "disconnecting") {
						setStatus("idle");
					}
				}),
			);

			// Phase 4 invariant 1: E2EE must be turned ON before the
			// websocket connects and before any media track is created
			// or published. Otherwise the initial publish path runs
			// without an encrypted transform, leaking media frames in
			// the clear (and dropping the initial peer-decode burst).
			if (e2eeCtx) {
				await r.setE2EEEnabled(true);
				if (disposed || myAttempt !== attempt) {
					await r.disconnect().catch(() => {});
					localBinding?.release();
					pendingBinding = null;
					return;
				}
			}

			await r.connect(url, jwt);
			if (disposed || myAttempt !== attempt) {
				await r.disconnect().catch(() => {});
				localBinding?.release();
				pendingBinding = null;
				return;
			}

			room = r;
			binding = localBinding;
			// Promoted to module-level — clear the pending handle so the
			// catch path doesn't double-release a binding that `teardown`
			// now owns.
			pendingBinding = null;

			// Honour the user's pre-call mic intent and serialize against the
			// reconcile loop. Holding `micOpPending` for the publish call
			// blocks the effect-driven `reconcileMic` from racing in and
			// issuing a concurrent `setMicrophoneEnabled` on the same
			// LocalParticipant while we're mid-publish (which would settle
			// out of order with this call). Any intent flip that lands
			// during the await is picked up by the post-await trampoline
			// below — which re-reads `opts.micEnabled()` and reconciles
			// against the now-settled SDK state. Without this trampoline
			// the reconcile-effect can short-circuit on a stale `actual`
			// read and silently lose the user's flip.
			micOpPending = true;
			try {
				const desiredOnPublish = opts.micEnabled();
				await r.localParticipant.setMicrophoneEnabled(desiredOnPublish);
			} finally {
				micOpPending = false;
			}
			if (disposed || myAttempt !== attempt) {
				// Disconnect THIS captured room only; do not call the shared
				// `teardown()` which operates on the module-level `room`.
				// A racing focus-change reconnect can establish a newer room
				// (and re-assign `room`) while we were awaiting
				// `setMicrophoneEnabled`; teardown would then disconnect the
				// wrong (live) room. We also intentionally avoid clearing
				// shared attachments/derived state here — those belong to the
				// current attempt and will be cleaned up by its own teardown.
				await r.disconnect().catch(() => {});
				// Same as the stale-after-connect arm: we own this binding
				// since it never reached the module-level `binding` slot.
				localBinding?.release();
				pendingBinding = null;
				return;
			}
			// Post-publish reconcile: catches any intent flip that arrived
			// during the publish-time await (the effect was blocked by
			// `micOpPending`). `reconcileMic` short-circuits when intent
			// already matches the now-settled SDK state, so this is a
			// cheap no-op when nothing changed.
			void reconcileMic(r);

			// Scan already-subscribed audio publications that arrived before our
			// TrackSubscribed listener fired (race window between connect resolve
			// and event delivery for an in-progress call).
			for (const p of r.remoteParticipants.values()) {
				for (const pub of p.audioTrackPublications.values()) {
					if (pub.isSubscribed && pub.audioTrack) {
						attachAudioTrack(pub.audioTrack as RemoteAudioTrack, pub);
					}
				}
				// Same race for video: a remote camera or screen-share publication
				// that landed before our TrackSubscribed listener won't fire one
				// for us.
				for (const pub of p.videoTrackPublications.values()) {
					if (!pub.isSubscribed || !pub.videoTrack) continue;
					if (pub.source === "camera") {
						// Skip a muted camera (joined with camera off) — its tile shows
						// the avatar until TrackUnmuted adds the track.
						if (pub.isMuted) continue;
						upsertVideoTrack(
							p.identity,
							pub.videoTrack as RemoteVideoTrack,
							pub.trackSid,
						);
					} else if (pub.source === "screen_share") {
						upsertScreenShareTrack(
							p.identity,
							pub.videoTrack as RemoteVideoTrack,
							pub.trackSid,
						);
					}
				}
			}

			snapshotParticipants(r);
			setStatus("connected");
		} catch (e) {
			// Compute the final user-facing error BEFORE any await so a fresh
			// `doConnect` that races in during teardown (which clears
			// `error` via `setError(null)`) isn't subsequently clobbered by
			// a stale post-await `setError(...)` from this catch.
			const baseErr =
				e instanceof Error
					? e
					: new Error(typeof e === "string" ? e : "Unknown LiveKit error");
			const finalErr =
				e instanceof LivekitJwtError
					? new Error(`Could not get LiveKit token: ${e.message}`)
					: baseErr;
			const stale = disposed || myAttempt !== attempt;
			// Sentinel for the post-disconnect re-check below. We capture
			// AFTER any !stale bump so a newer attempt (started during the
			// disconnect await) makes `postBump !== attempt` and trips the
			// re-check, preventing us from tearing down its live `room`.
			let postBump = attempt;
			if (!stale) {
				setError(finalErr);
				setStatus("error");
				// Invalidate this attempt BEFORE any await so any LiveKit
				// events that fire during the async disconnect (track
				// unsubscribed, participant disconnected, AND the Disconnected
				// handler's own `attempt++`) bail through `ifLive` and can't
				// re-attach audio, re-populate participants, or — critically
				// — bump `attempt` out from under us. We already set
				// `error`/`status` above so bumping here is safe.
				//
				// CRITICAL: bump ONLY when !stale. If we are already stale a
				// newer attempt owns `attempt`; bumping here would invalidate
				// that newer attempt at its next stale check, silently
				// aborting a live reconnect. The stale path's Disconnected
				// handler is already `ifLive`-gated and bails because
				// `myAttempt !== attempt`, so no bump is needed there.
				attempt++;
				postBump = attempt;
			}
			// If we created a Room but never assigned it to module-level
			// `room` (connect rejected, or any throw before `room = r;`),
			// teardown won't disconnect it. Explicitly disconnect here so
			// its WebSocket/listeners don't outlive this failed attempt.
			// Run this BEFORE the stale return so superseded attempts also
			// reclaim the orphaned Room.
			if (pendingRoom && pendingRoom !== room) {
				await pendingRoom.disconnect().catch(() => {});
			}
			// Release a binding the catch path created but never promoted
			// to module-level. If `binding` already points at `localBinding`
			// (we got past `binding = localBinding;` then threw), teardown
			// below owns the release — skip to avoid a double release.
			if (pendingBinding && pendingBinding !== binding) {
				pendingBinding.release();
				pendingBinding = null;
			}
			if (stale) return;
			// Re-check liveness AFTER the disconnect await: a reactive tick
			// (focus change, enabled toggle) could have started a newer
			// `doConnect` while we yielded. If so, the newer attempt may have
			// already assigned its `room`, and calling `teardown()` now would
			// disconnect that live room and wipe its attachments.
			if (disposed || postBump !== attempt) return;
			await trackTeardown();
		}
	};

	// Drive (re)connect on enabled+focus changes. Mute toggle and deviceId
	// change DO NOT trigger here — they're handled imperatively below.
	createEffect(
		on([opts.enabled, opts.focus], ([enabled, focus]) => {
			if (disposed) return;
			if (!enabled || focus === null) {
				// Disable / no focus → tear down any live connection. Catch
				// "disconnecting" too so an in-flight focus-change teardown
				// gets a final transition to "idle" rather than being left
				// suspended with a stale status.
				if (room || status() === "connecting" || status() === "disconnecting") {
					const epoch = ++attempt;
					setStatus("disconnecting");
					void trackTeardown().then(() => {
						if (disposed) return;
						// Bail if a later effect run or explicit disconnect()
						// superseded us — without this guard, the late
						// setStatus("idle") would clobber a freshly-started
						// reconnect's "connecting" state and silently lie.
						if (epoch !== attempt) return;
						setStatus("idle");
					});
				}
				return;
			}
			// `enabled` stayed true but `focus` changed (or another connect /
			// teardown is in flight) — tear down the existing room before
			// starting a new attempt so we don't orphan a LiveKit connection
			// with attached audio elements pointing at the previous focus.
			//
			// If an explicit user-initiated `disconnect()` is in flight, bail:
			// the consumer awaits livekit.disconnect() BEFORE rtc.leave(), so
			// `enabled` is still true here, and re-entering the call via a
			// late focus/membership tick would undo the user's Leave click.
			if (explicitDisconnect()) return;
			// We set status to "disconnecting" (mirroring the disable branch)
			// so a subsequent disable transition can observe in-flight
			// teardown via its guard. Capture `epoch = ++attempt` and re-check
			// `epoch === attempt` inside .then() so a later effect run or an
			// explicit `disconnect()` (both of which bump `attempt`) wins
			// over this queued reconnect — without that check, the queued
			// `doConnect` would resurrect a call the user explicitly left.
			if (room || status() === "connecting" || status() === "disconnecting") {
				const epoch = ++attempt;
				setStatus("disconnecting");
				const targetFocus = focus;
				void trackTeardown().then(() => {
					if (disposed) return;
					if (epoch !== attempt) return; // superseded by another caller
					// Compare on `livekit_service_url` rather than reference so
					// a membership-update tick that re-emits a referentially-new
					// `LivekitTransport` for the same focus doesn't flip us to
					// "idle" and silently skip the reconnect.
					const current = opts.focus();
					if (
						opts.enabled() &&
						current?.livekit_service_url === targetFocus.livekit_service_url
					) {
						void doConnect(targetFocus);
					} else {
						setStatus("idle");
					}
				});
				return;
			}
			void doConnect(focus);
		}),
	);

	// Re-resolve display names when the membership list changes (a new joiner
	// adds a `rtcBackendIdentity → userId` mapping we couldn't resolve before).
	createEffect(
		on(opts.memberships, () => {
			if (room) snapshotParticipants(room);
		}),
	);

	// Mic single-flight reconcile loop. Driven by `createEffect` on
	// `opts.micEnabled`; voice store is the source of truth for intent.
	// Mirrors the `setLocalCamEnabled` pattern: rapid intent flips settle on
	// the latest read regardless of which SDK promise resolves first.
	const reconcileMic = async (r: LivekitRoom): Promise<void> => {
		if (micOpPending) return;
		micOpPending = true;
		try {
			while (true) {
				if (disposed) return;
				if (room !== r) return;
				const desired = opts.micEnabled();
				const actual = r.localParticipant.isMicrophoneEnabled === true;
				if (actual === desired) return;
				const myAttempt = attempt;
				try {
					await r.localParticipant.setMicrophoneEnabled(desired);
				} catch (e) {
					if (disposed || myAttempt !== attempt || room !== r) return;
					// Surface error but don't mutate intent — the voice store
					// is the source of truth for what the user wants.
					setError(e instanceof Error ? e : new Error(String(e)));
					return;
				}
				if (disposed || myAttempt !== attempt || room !== r) return;
			}
		} finally {
			micOpPending = false;
		}
	};

	// Drive the mic reconcile loop on every intent flip from the voice store.
	// On first run with `room === null` this is a no-op; the publish-time
	// call inside `tryConnect` handles the initial publish, and subsequent
	// effect runs catch every flip thereafter.
	createEffect(
		on(opts.micEnabled, () => {
			const r = room;
			if (r) void reconcileMic(r);
		}),
	);

	const setLocalCamEnabled = async (enabled: boolean): Promise<void> => {
		// Optimistic write of user intent. The reconcile loop below drives
		// LiveKit to the latest signal value — rapid enable→disable settles
		// to the last clicked state even if SDK promises resolve out of order.
		setLocalCamEnabledSignal(enabled);
		const r = room;
		if (!r) return;
		// Single-flight: another in-flight reconcile will pick up the latest
		// `localCamEnabled()` signal on its next loop iteration.
		if (cameraOpPending) return;
		cameraOpPending = true;
		try {
			// Drive until LiveKit's actual state matches user intent. If the
			// user toggles again during an await, the loop catches it.
			// Bounded by `disposed` / `attempt` / `room` checks so a teardown
			// or reconnect mid-loop bails immediately.
			while (true) {
				if (disposed) return;
				const r2 = room;
				if (!r2 || r2 !== r) return;
				const desired = localCamEnabled();
				const actual = r2.localParticipant.isCameraEnabled === true;
				if (actual === desired) return;
				const myAttempt = attempt;
				try {
					await r2.localParticipant.setCameraEnabled(desired, {
						deviceId: opts.videoDeviceId() || undefined,
					});
				} catch (e) {
					if (disposed || myAttempt !== attempt || room !== r2) return;
					// Revert the optimistic flip to actual SDK state, surface error.
					setLocalCamEnabledSignal(
						r2.localParticipant.isCameraEnabled === true,
					);
					setError(e instanceof Error ? e : new Error(String(e)));
					return;
				}
				if (disposed || myAttempt !== attempt || room !== r2) return;
				// Loop again: the user may have toggled during the await; if
				// not, the next iteration's actual===desired check returns.
			}
		} finally {
			cameraOpPending = false;
		}
	};

	const setLocalScreenShareEnabled = async (
		enabled: boolean,
	): Promise<void> => {
		// Fail closed where the browser can't capture a display (most mobile
		// browsers): never optimistically flip the toggle, surface a clear error.
		if (enabled && !screenShareSupported) {
			setError(new Error("Screen sharing isn't supported on this device"));
			return;
		}
		// Optimistic intent write + single-flight reconcile, mirroring
		// `setLocalCamEnabled`. `setScreenShareEnabled(true)` opens the browser's
		// display picker via getDisplayMedia, so this must run from the click's
		// user gesture (it does — driven by the control-bar button).
		setLocalScreenShareEnabledSignal(enabled);
		const r = room;
		if (!r) return;
		if (screenShareOpPending) return;
		screenShareOpPending = true;
		try {
			while (true) {
				if (disposed) return;
				const r2 = room;
				if (!r2 || r2 !== r) return;
				const desired = localScreenShareEnabled();
				const actual = r2.localParticipant.isScreenShareEnabled === true;
				if (actual === desired) return;
				const myAttempt = attempt;
				try {
					// Read the quality fresh each enable so the picker's current
					// value wins; the spec drives BOTH the capture frameRate (LiveKit
					// caps capture at 30fps by default — 60 needs this) and the
					// encoder ceiling (its stock default is a choppy 1080p15). The
					// options are ignored on the disable path, so passing them
					// unconditionally is harmless.
					const spec = screenShareQualitySpec(opts.screenShareQuality?.());
					await r2.localParticipant.setScreenShareEnabled(
						desired,
						{ audio: true, resolution: spec.resolution },
						{ screenShareEncoding: spec.encoding },
					);
				} catch (e) {
					if (disposed || myAttempt !== attempt || room !== r2) return;
					// Revert the optimistic flip to actual SDK state, surface error.
					// A user-cancelled display picker rejects here and correctly
					// settles the toggle back to off.
					setLocalScreenShareEnabledSignal(
						r2.localParticipant.isScreenShareEnabled === true,
					);
					setError(e instanceof Error ? e : new Error(String(e)));
					return;
				}
				if (disposed || myAttempt !== attempt || room !== r2) return;
			}
		} finally {
			screenShareOpPending = false;
		}
	};

	const explicitDisconnect = (): boolean => explicitDisconnectDepth > 0;

	const disconnect = async (): Promise<void> => {
		// Bump the depth BEFORE the idle short-circuit so that a focus/membership
		// tick racing in immediately after this call (between our attempt bump
		// and a subsequent createEffect run) still sees the explicit-disconnect
		// guard and bails out of the focus-change branch. Without this, callers
		// that invoke disconnect() while already idle would invalidate the epoch
		// (via attempt++) but leave explicitDisconnect() returning false, opening
		// a small window where a stale focus change could queue a reconnect.
		explicitDisconnectDepth += 1;
		try {
			attempt += 1;
			if (status() === "idle") return;
			setStatus("disconnecting");
			await trackTeardown();
			if (!disposed) setStatus("idle");
		} finally {
			explicitDisconnectDepth -= 1;
		}
	};

	const resumeAudio = async (): Promise<void> => {
		const r = room;
		let startAudioOk = false;
		if (r) {
			try {
				await r.startAudio();
				startAudioOk = true;
			} catch {
				/* ignore — fallback below */
			}
		}
		const allPlayed = await tryPlayAll();
		// Only clear the blocked banner once we've actually unblocked audio.
		// If no tracks are attached yet, fall back to startAudio's outcome
		// (LiveKit considers the room unblocked once startAudio resolves).
		if (allPlayed && (attachments.size > 0 || startAudioOk)) {
			setAudioBlocked(false);
		}
	};

	onCleanup(() => {
		disposed = true;
		attempt += 1;
		// Record the teardown promise so external chain consumers (the
		// bridge dispose in CallSessionController) can defer their own
		// destructive work until disconnect has released its binding.
		// Chains via trackTeardown so an in-flight focus-change or
		// explicit-disconnect teardown finishes its `r.disconnect()`
		// (and binding release) BEFORE this unmount-driven no-op
		// teardown resolves.
		void trackTeardown();
	});

	return {
		status,
		error,
		participants,
		localCamEnabled,
		setLocalCamEnabled,
		localScreenShareEnabled,
		setLocalScreenShareEnabled,
		screenShareSupported,
		videoTracks,
		screenShareTracks,
		disconnect,
		audioBlocked,
		resumeAudio,
		// Resolves when any in-flight teardown (from cleanup or an
		// explicit disconnect) has run `r.disconnect()` AND released
		// its E2EE binding. Resolves immediately if no teardown has
		// ever been triggered. Used by CallSessionController's bridge-dispose
		// onCleanup to chain `ctx.dispose()` (which terminates workers)
		// behind the disconnect that's still using them — Solid's
		// `onCleanup` is synchronous and can't enforce this via LIFO.
		teardownComplete: (): Promise<void> => teardownPromise,
	};
}
