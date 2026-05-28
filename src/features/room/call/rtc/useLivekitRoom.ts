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
	// Number of explicit user-initiated `disconnect()` calls currently in
	// flight. Held > 0 for the duration of teardown so a concurrent focus/
	// membership update doesn't slip a reconnect into the focus-change
	// branch while the user is on their way out. The consumer
	// (`NativeCallView`) awaits `livekit.disconnect()` BEFORE `rtc.leave()`,
	// so `enabled` (gated on `rtc.status()==="joined"`) is still true during
	// the teardown — without this guard, focus churn can re-enter the call
	// after the user clicked Leave. A counter (not a boolean) so overlapping
	// disconnect calls don't clear the guard prematurely.
	let explicitDisconnectDepth = 0;
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

	// Reset call-derived UI state. Called from both `teardown()` (intentional
	// disconnects) and the `Disconnected` event handler (unsolicited drops)
	// so the participant list doesn't outlive the call. NOTE: `localMuted` is
	// treated as a persistent user preference (mute carries across calls and
	// retries) and is intentionally NOT reset here — clearing it on connect
	// errors would silently flip a pre-muted user back to unmuted on retry.
	const resetCallDerivedState = (): void => {
		setParticipants([]);
		setAudioBlocked(false);
	};

	const teardown = async (): Promise<void> => {
		detachAll();
		resetCallDerivedState();
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
				lk.RoomEvent.ParticipantDisconnected,
				ifLive(() => snapshotParticipants(r)),
			);
			r.on(
				lk.RoomEvent.ActiveSpeakersChanged,
				ifLive(() => snapshotParticipants(r)),
			);
			r.on(
				lk.RoomEvent.TrackMuted,
				ifLive(() => snapshotParticipants(r)),
			);
			r.on(
				lk.RoomEvent.TrackUnmuted,
				ifLive(() => snapshotParticipants(r)),
			);
			r.on(
				lk.RoomEvent.LocalTrackPublished,
				ifLive(() => {
					setLocalMutedSignal(r.localParticipant.isMicrophoneEnabled === false);
					snapshotParticipants(r);
				}),
			);
			r.on(
				lk.RoomEvent.TrackSubscribed,
				ifLive((track: RemoteTrack, publication: RemoteTrackPublication) => {
					if (track.kind === lk.Track.Kind.Audio) {
						attachAudioTrack(track as RemoteAudioTrack, publication);
					}
					snapshotParticipants(r);
				}),
			);
			r.on(
				lk.RoomEvent.TrackUnsubscribed,
				ifLive((_t: RemoteTrack, publication: RemoteTrackPublication) => {
					detachAudioTrack(publication.trackSid);
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
					// `setLocalMuted` doesn't invoke SDK methods on a dead room.
					resetCallDerivedState();
					room = null;
					// Preserve terminal/intentional states so an unsolicited
					// Disconnected event doesn't clobber the user-visible error
					// or override an in-flight explicit disconnect.
					const s = status();
					if (s !== "error" && s !== "disconnecting") {
						setStatus("idle");
					}
				}),
			);

			await r.connect(url, jwt);
			if (disposed || myAttempt !== attempt) {
				await r.disconnect().catch(() => {});
				return;
			}

			room = r;

			// Honour the user's pre-mute preference: if they toggled mute
			// before we connected (via `setLocalMuted`), publish disabled so
			// the LiveKit publication starts muted. Otherwise enable the mic
			// for the common "click join, talk immediately" flow.
			//
			// We deliberately do NOT write `setLocalMutedSignal(desiredMuted)`
			// after the await: the signal already holds `desiredMuted`, and if
			// the user toggles mute concurrently during the SDK round-trip
			// their write should win. `LocalTrackPublished` will reconcile the
			// signal to the actual SDK state once the publication settles.
			const desiredMuted = localMuted();
			await r.localParticipant.setMicrophoneEnabled(!desiredMuted);
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
				return;
			}

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
			setError(finalErr);
			setStatus("error");
			// Invalidate this attempt BEFORE teardown so any LiveKit events
			// that fire during the async disconnect (track unsubscribed,
			// participant disconnected) bail through `ifLive` and can't
			// re-attach audio or re-populate participants after
			// `detachAll()` / `resetCallDerivedState()` runs.
			attempt++;
			await teardown();
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
					void teardown().then(() => {
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
				void teardown().then(() => {
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

	const setLocalMuted = async (muted: boolean): Promise<void> => {
		const r = room;
		if (!r) {
			// Optimistic: remember the desired state so the next publish honors it.
			setLocalMutedSignal(muted);
			return;
		}
		// Optimistic UI update — the LiveKit call below settles asynchronously.
		setLocalMutedSignal(muted);
		// Snapshot the current attempt epoch so a teardown/reconnect that
		// races in during the SDK round-trip doesn't have its
		// `resetCallDerivedState()` clobbered by a stale post-await write,
		// and we don't issue setError against a dead room.
		const myAttempt = attempt;
		try {
			await r.localParticipant.setMicrophoneEnabled(!muted);
			if (disposed || myAttempt !== attempt || room !== r) return;
			snapshotParticipants(r);
		} catch (e) {
			if (disposed || myAttempt !== attempt || room !== r) return;
			// Revert on failure.
			setLocalMutedSignal(r.localParticipant.isMicrophoneEnabled === false);
			setError(e instanceof Error ? e : new Error(String(e)));
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
			await teardown();
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
