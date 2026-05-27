import type {
	Room as LivekitRoom,
	RemoteAudioTrack,
	RemoteTrack,
	RemoteTrackPublication,
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
import { fetchLivekitToken, LivekitJwtError } from "./fetchLivekitToken";

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
	 * Loader for the livekit-client module. Defaults to a dynamic import so
	 * the LiveKit chunk is only fetched on Join. Tests inject a synchronous
	 * loader returning a mock module.
	 */
	loadLivekit?: () => Promise<typeof import("livekit-client")>;
}

export interface LivekitRoomApi {
	status: Accessor<LivekitConnectionStatus>;
	error: Accessor<Error | null>;
	participants: Accessor<readonly RtcParticipant[]>;
	localMuted: Accessor<boolean>;
	setLocalMuted: (muted: boolean) => Promise<void>;
	/** Disconnects, stops local mic, detaches all audio. Idempotent. */
	disconnect: () => Promise<void>;
	/**
	 * True when autoplay was blocked; user gesture required.
	 * Calling `resumeAudio` will retry start.
	 */
	audioBlocked: Accessor<boolean>;
	resumeAudio: () => Promise<void>;
}

interface AttachedAudio {
	element: HTMLAudioElement;
	track: RemoteAudioTrack;
}

/**
 * Phase 2 LiveKit room wrapper for the native MatrixRTC client (#122).
 *
 * Dynamically imports `livekit-client` inside the connect path so neither
 * app boot nor opening `NativeCallView` pulls the chunk — only the first
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
	const [localMuted, setLocalMutedSignal] = createSignal(false);
	const [audioBlocked, setAudioBlocked] = createSignal(false);

	let room: LivekitRoom | null = null;
	let attempt = 0;
	let disposed = false;
	const attachments = new Map<string, AttachedAudio>();

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

	const tryPlayAll = (): void => {
		let blocked = false;
		for (const a of attachments.values()) {
			a.element.play().catch(() => {
				blocked = true;
			});
		}
		if (blocked) setAudioBlocked(true);
	};

	const resolveDisplayName = (identity: string): string => {
		// LiveKit identity is the MatrixRTC backend identity. Map back through
		// the membership list to a userId, then resolve a display name.
		const membership = opts
			.memberships()
			.find((m) => m.rtcBackendIdentity === identity);
		if (!membership) return identity;
		const user = opts.client.getUser(membership.userId);
		return user?.displayName ?? membership.userId;
	};

	const snapshotParticipants = (r: LivekitRoom): void => {
		const speakingIds = new Set(r.activeSpeakers.map((p) => p.identity));
		const out: RtcParticipant[] = [];
		out.push({
			identity: r.localParticipant.identity,
			displayName: resolveDisplayName(r.localParticipant.identity),
			isSpeaking: speakingIds.has(r.localParticipant.identity),
			isMuted: r.localParticipant.isMicrophoneEnabled === false,
			isLocal: true,
		});
		for (const p of r.remoteParticipants.values()) {
			const micPub = Array.from(p.audioTrackPublications.values()).find(
				(pub) => pub.source === "microphone",
			);
			out.push({
				identity: p.identity,
				displayName: resolveDisplayName(p.identity),
				isSpeaking: speakingIds.has(p.identity),
				isMuted: micPub?.isMuted ?? true,
				isLocal: false,
			});
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
		el.play().catch(() => setAudioBlocked(true));
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

	const teardown = async (): Promise<void> => {
		detachAll();
		const r = room;
		room = null;
		if (r) {
			try {
				await r.disconnect();
			} catch {
				/* swallow — best-effort */
			}
		}
	};

	const doConnect = async (focus: LivekitTransport): Promise<void> => {
		const myAttempt = ++attempt;
		setError(null);
		setStatus("connecting");

		try {
			// Dynamic import: this is the moment LiveKit's chunk first loads.
			const lk = await (opts.loadLivekit ?? (() => import("livekit-client")))();
			if (disposed || myAttempt !== attempt) return;

			const openIdToken = await opts.client.getOpenIdToken();
			if (disposed || myAttempt !== attempt) return;

			const { url, jwt } = await fetchLivekitToken(focus, openIdToken);
			if (disposed || myAttempt !== attempt) return;

			const r = new lk.Room({
				adaptiveStream: true,
				dynacast: true,
				audioCaptureDefaults: {
					deviceId: opts.audioDeviceId() || undefined,
				},
			});
			// participant/track events for a call already in progress.
			// Register listeners BEFORE connect so we don't miss the initial
			// participant/track events for a call already in progress.
			r.on(lk.RoomEvent.ParticipantConnected, () => snapshotParticipants(r));
			r.on(lk.RoomEvent.ParticipantDisconnected, () => snapshotParticipants(r));
			r.on(lk.RoomEvent.ActiveSpeakersChanged, () => snapshotParticipants(r));
			r.on(lk.RoomEvent.TrackMuted, () => snapshotParticipants(r));
			r.on(lk.RoomEvent.TrackUnmuted, () => snapshotParticipants(r));
			r.on(lk.RoomEvent.LocalTrackPublished, () => {
				setLocalMutedSignal(r.localParticipant.isMicrophoneEnabled === false);
				snapshotParticipants(r);
			});
			r.on(
				lk.RoomEvent.TrackSubscribed,
				(track: RemoteTrack, publication: RemoteTrackPublication) => {
					if (track.kind === lk.Track.Kind.Audio) {
						attachAudioTrack(track as RemoteAudioTrack, publication);
					}
					snapshotParticipants(r);
				},
			);
			r.on(
				lk.RoomEvent.TrackUnsubscribed,
				(_t: RemoteTrack, publication: RemoteTrackPublication) => {
					detachAudioTrack(publication.trackSid);
					snapshotParticipants(r);
				},
			);
			r.on(lk.RoomEvent.Disconnected, () => {
				// Only react if this is still the live attempt — otherwise the
				// teardown loop is already running.
				if (myAttempt !== attempt) return;
				detachAll();
				setStatus("idle");
			});

			await r.connect(url, jwt);
			if (disposed || myAttempt !== attempt) {
				await r.disconnect().catch(() => {});
				return;
			}

			room = r;

			// Publish default mic. If the user pre-muted, publish then disable.
			await r.localParticipant.setMicrophoneEnabled(true);
			if (disposed || myAttempt !== attempt) {
				await teardown();
				return;
			}
			setLocalMutedSignal(false);

			// Scan already-subscribed audio publications that arrived before our
			// TrackSubscribed listener fired (race window between connect resolve
			// and event delivery for an in-progress call).
			for (const p of r.remoteParticipants.values()) {
				for (const pub of p.audioTrackPublications.values()) {
					if (pub.isSubscribed && pub.audioTrack) {
						attachAudioTrack(pub.audioTrack as RemoteAudioTrack, pub);
					}
				}
			}

			snapshotParticipants(r);
			setStatus("connected");
		} catch (e) {
			if (disposed || myAttempt !== attempt) return;
			const err =
				e instanceof Error
					? e
					: new Error(typeof e === "string" ? e : "Unknown LiveKit error");
			setError(err);
			setStatus("error");
			await teardown();
			// Surface a friendlier message for the common JWT failure mode.
			if (e instanceof LivekitJwtError) {
				setError(new Error(`Could not get LiveKit token: ${e.message}`));
			}
		}
	};

	// Drive (re)connect on enabled+focus changes. Mute toggle and deviceId
	// change DO NOT trigger here — they're handled imperatively below.
	createEffect(
		on([opts.enabled, opts.focus], ([enabled, focus]) => {
			if (disposed) return;
			if (!enabled || focus === null) {
				// Disable / no focus → tear down any live connection.
				if (room || status() === "connecting") {
					attempt += 1; // invalidate any in-flight attempt
					setStatus("disconnecting");
					void teardown().then(() => {
						if (!disposed) setStatus("idle");
					});
				}
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

	const setLocalMuted = async (muted: boolean): Promise<void> => {
		const r = room;
		if (!r) {
			// Optimistic: remember the desired state so the next publish honors it.
			setLocalMutedSignal(muted);
			return;
		}
		// Optimistic UI update — the LiveKit call below settles asynchronously.
		setLocalMutedSignal(muted);
		try {
			await r.localParticipant.setMicrophoneEnabled(!muted);
			snapshotParticipants(r);
		} catch (e) {
			// Revert on failure.
			setLocalMutedSignal(r.localParticipant.isMicrophoneEnabled === false);
			setError(e instanceof Error ? e : new Error(String(e)));
		}
	};

	const disconnect = async (): Promise<void> => {
		attempt += 1;
		if (status() === "idle") return;
		setStatus("disconnecting");
		await teardown();
		if (!disposed) setStatus("idle");
	};

	const resumeAudio = async (): Promise<void> => {
		const r = room;
		if (r) {
			try {
				await r.startAudio();
			} catch {
				/* ignore — fallback below */
			}
		}
		tryPlayAll();
		setAudioBlocked(false);
	};

	onCleanup(() => {
		disposed = true;
		attempt += 1;
		void teardown();
	});

	return {
		status,
		error,
		participants,
		localMuted,
		setLocalMuted,
		disconnect,
		audioBlocked,
		resumeAudio,
	};
}
