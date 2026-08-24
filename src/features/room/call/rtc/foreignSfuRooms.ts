import type {
	Room as LivekitRoom,
	LocalVideoTrack,
	RemoteAudioTrack,
	RemoteTrack,
	RemoteTrackPublication,
	RemoteVideoTrack,
} from "livekit-client";
import type { MatrixClient } from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";
import { reportError } from "../../../../lib/reportError";
import { fetchLivekitToken } from "./fetchLivekitToken";
import type { RtcE2EEContext, RtcE2EERoomBinding } from "./rtcE2EEBridge";

/**
 * Subscriber-only LiveKit connections to *foreign* SFUs — the receive half
 * of multi-SFU support (#495/#497).
 *
 * In `multi_sfu` topologies every client publishes to its own SFU and
 * subscribes to every other SFU in the call. Crust publishes exactly once,
 * to the elected/primary focus (`useLivekitRoom`'s room); this module opens
 * one additional receive-only connection per distinct foreign SFU that some
 * membership publishes to, so those peers become audible/visible.
 *
 * Deliberately a plain factory with injected dependencies - no Solid
 * primitives. `useLivekitRoom` owns all reactivity (it derives the desired
 * origin set from memberships and calls `reconcile`), and this module
 * reuses the hook's hardened media machinery (audio attachment, video /
 * screen-share maps) through callbacks so foreign tracks flow into the
 * exact same UI surfaces as primary ones.
 *
 * Invariants:
 *  - NEVER publishes: no `setMicrophoneEnabled` / `setCameraEnabled` /
 *    screen share on foreign rooms. Peers on those SFUs hear us through
 *    their own subscriber connection to our SFU.
 *  - Per-origin failure isolation: a failed foreign connect logs
 *    console-only (`reportError` without `userMessage` - the primary call
 *    surface already communicates overall call state, and the #494
 *    "different server" badge keeps signalling the unreachable peer) and
 *    never affects the primary room.
 *  - E2EE ordering matches the primary path: `bindRoom()` before Room
 *    construction, `setE2EEEnabled(true)` before `connect()`. The bridge
 *    fans every key into all acquired bindings (#496).
 *  - Same stale-guard discipline as `useLivekitRoom`: every await captures
 *    the per-origin epoch before and re-checks after, so a reconcile that
 *    removes an origin mid-connect wins over the in-flight connect.
 */

/** Minimum wait before a failed origin is eligible for another connect
 *  attempt. Retries piggyback on `reconcile` calls (membership ticks) -
 *  there is no timer - so this only rate-limits, it does not schedule. */
export const FOREIGN_RETRY_MS = 30_000;

export type ForeignRoomState = "connecting" | "connected" | "failed";

export interface ForeignRoomHandle {
	/** Canonical SFU origin this connection targets. */
	origin: string;
	state: ForeignRoomState;
	/** The connected LiveKit room, or null while connecting/failed. */
	room: LivekitRoom | null;
}

export interface ForeignSfuRoomsDeps {
	client: Pick<MatrixClient, "getOpenIdToken" | "getDeviceId">;
	loadLivekit: () => Promise<typeof import("livekit-client")>;
	/** Current E2EE context, or null for unencrypted rooms. Read at
	 *  connect time per origin (matches the primary connect path). */
	e2ee: () => RtcE2EEContext | null;
	/** Media sinks shared with the primary room - foreign tracks land in
	 *  the same maps/elements so the UI needs no notion of "which room". */
	attachAudioTrack(
		track: RemoteAudioTrack,
		publication: RemoteTrackPublication,
	): void;
	detachAudioTrack(sid: string): void;
	upsertVideoTrack(
		identity: string,
		track: LocalVideoTrack | RemoteVideoTrack,
		sid: string,
	): void;
	removeVideoTrackIfMatches(identity: string, sid: string): void;
	upsertScreenShareTrack(
		identity: string,
		track: LocalVideoTrack | RemoteVideoTrack,
		sid: string,
	): void;
	removeScreenShareTrackIfMatches(identity: string, sid: string): void;
	/** Track/mute/speaking state in some foreign room changed - the hook
	 *  re-snapshots the merged participant list. */
	onChanged(): void;
	/** A participant joined/left a foreign room (or a room's connection
	 *  state changed) - the hook re-snapshots AND gives the presence cue
	 *  a chance to sound, mirroring the primary room's event split. */
	onRosterChanged(): void;
	/** Clock seam for the failure-retry backoff. Tests inject a fake. */
	now?: () => number;
}

export interface ForeignSfuRooms {
	/**
	 * Drive the connection set toward `desired` (canonical origin →
	 * transport to dial). Missing origins are connected, removed origins
	 * are torn down, failed origins are re-attempted when they are still
	 * desired and `FOREIGN_RETRY_MS` has elapsed since the failure.
	 * Synchronous bookkeeping; connects/disconnects run in the
	 * background. Safe to call repeatedly with the same map.
	 */
	reconcile(desired: ReadonlyMap<string, LivekitTransport>): void;
	/** Current per-origin connection handles (for merge + badge logic). */
	rooms(): ForeignRoomHandle[];
	/**
	 * Look up one origin's connection state. Convenience for the badge
	 * semantics: a foreign peer keeps the "different server" cue only
	 * while their SFU is not `connected`.
	 */
	stateOf(origin: string): ForeignRoomState | undefined;
	/**
	 * Tear down every current connection but keep the instance usable -
	 * the hook calls this from its shared `teardown()` (explicit
	 * disconnect, unsolicited drop, focus-change reconnect), after which
	 * a later `reconcile` may rebuild the set. Resolves after every room
	 * has disconnected and released its E2EE binding (same ordering as
	 * the primary teardown: disconnect first, then release) so the
	 * controller can safely dispose the E2EE context afterwards.
	 */
	clear(): Promise<void>;
	/**
	 * Terminal `clear()`: also marks the instance disposed so a stray
	 * late `reconcile` cannot reconnect anything. Idempotent.
	 */
	disposeAll(): Promise<void>;
}

interface OriginEntry {
	origin: string;
	transport: LivekitTransport;
	state: ForeignRoomState;
	/** Bumped to invalidate in-flight work for this origin. */
	epoch: number;
	room: LivekitRoom | null;
	binding: RtcE2EERoomBinding | null;
	/** Media this origin added to the shared sinks, so a targeted
	 *  teardown can remove exactly its contributions (the primary room's
	 *  whole-map resets don't apply to a single-origin removal). */
	audioSids: Set<string>;
	/** identity → sid for entries this origin put into the video map. */
	videoEntries: Map<string, string>;
	shareEntries: Map<string, string>;
	/** Set when `state === "failed"`; gates the retry backoff. */
	failedAt: number;
}

export function createForeignSfuRooms(
	deps: ForeignSfuRoomsDeps,
): ForeignSfuRooms {
	const now = deps.now ?? (() => Date.now());
	const entries = new Map<string, OriginEntry>();
	let disposed = false;

	const cleanupMedia = (entry: OriginEntry): void => {
		for (const sid of entry.audioSids) deps.detachAudioTrack(sid);
		entry.audioSids.clear();
		for (const [identity, sid] of entry.videoEntries) {
			deps.removeVideoTrackIfMatches(identity, sid);
		}
		entry.videoEntries.clear();
		for (const [identity, sid] of entry.shareEntries) {
			deps.removeScreenShareTrackIfMatches(identity, sid);
		}
		entry.shareEntries.clear();
	};

	/** Disconnect + release one origin's resources. The entry itself is
	 *  removed (or kept for retry bookkeeping) by the caller. */
	const teardownEntry = async (entry: OriginEntry): Promise<void> => {
		entry.epoch++;
		cleanupMedia(entry);
		const r = entry.room;
		entry.room = null;
		const b = entry.binding;
		entry.binding = null;
		if (r) {
			try {
				await r.disconnect();
			} catch {
				/* best-effort */
			}
		}
		// Release AFTER disconnect resolves so LiveKit's close handlers
		// finish with the keyProvider/worker first (primary-path ordering).
		b?.release();
	};

	const connectOrigin = async (entry: OriginEntry): Promise<void> => {
		const myEpoch = entry.epoch;
		const stale = (): boolean => disposed || entry.epoch !== myEpoch;
		// Hoisted for the catch path: resources created but not yet
		// promoted onto the entry must still be reclaimed on failure.
		let pendingRoom: LivekitRoom | null = null;
		let pendingBinding: RtcE2EERoomBinding | null = null;
		try {
			const lk = await deps.loadLivekit();
			if (stale()) return;
			const openIdToken = await deps.client.getOpenIdToken();
			if (stale()) return;
			const deviceId = deps.client.getDeviceId();
			if (!deviceId) {
				throw new Error("Matrix client has no device ID");
			}
			const { url, jwt } = await fetchLivekitToken(
				entry.transport,
				openIdToken,
				deviceId,
			);
			if (stale()) return;

			const e2eeCtx = deps.e2ee();
			const binding = e2eeCtx?.bindRoom() ?? null;
			pendingBinding = binding;
			const r = new lk.Room({
				// Receive-only: no capture defaults, no publish options.
				// adaptiveStream keeps foreign video from wasting bandwidth
				// on tiles the layout renders small, same as the primary.
				adaptiveStream: true,
				e2ee: binding?.e2eeOptions ?? undefined,
			});
			pendingRoom = r;

			const ifLive = <Args extends unknown[]>(
				fn: (...args: Args) => void,
			): ((...args: Args) => void) => {
				return (...args: Args): void => {
					if (stale()) return;
					fn(...args);
				};
			};

			r.on(
				lk.RoomEvent.TrackSubscribed,
				ifLive(
					(
						track: RemoteTrack,
						publication: RemoteTrackPublication,
						participant: { identity: string },
					) => {
						if (track.kind === lk.Track.Kind.Audio) {
							deps.attachAudioTrack(track as RemoteAudioTrack, publication);
							entry.audioSids.add(publication.trackSid);
						} else if (track.kind === lk.Track.Kind.Video) {
							if (publication.source === lk.Track.Source.Camera) {
								if (!publication.isMuted) {
									deps.upsertVideoTrack(
										participant.identity,
										track as RemoteVideoTrack,
										publication.trackSid,
									);
									entry.videoEntries.set(
										participant.identity,
										publication.trackSid,
									);
								}
							} else if (publication.source === lk.Track.Source.ScreenShare) {
								deps.upsertScreenShareTrack(
									participant.identity,
									track as RemoteVideoTrack,
									publication.trackSid,
								);
								entry.shareEntries.set(
									participant.identity,
									publication.trackSid,
								);
							}
						}
						deps.onChanged();
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
							deps.detachAudioTrack(publication.trackSid);
							entry.audioSids.delete(publication.trackSid);
						} else if (track.kind === lk.Track.Kind.Video) {
							if (publication.source === lk.Track.Source.Camera) {
								deps.removeVideoTrackIfMatches(
									participant.identity,
									publication.trackSid,
								);
								if (
									entry.videoEntries.get(participant.identity) ===
									publication.trackSid
								) {
									entry.videoEntries.delete(participant.identity);
								}
							} else if (publication.source === lk.Track.Source.ScreenShare) {
								deps.removeScreenShareTrackIfMatches(
									participant.identity,
									publication.trackSid,
								);
								if (
									entry.shareEntries.get(participant.identity) ===
									publication.trackSid
								) {
									entry.shareEntries.delete(participant.identity);
								}
							}
						}
						deps.onChanged();
					},
				),
			);
			// Camera mute/unmute flips the tile between video and avatar,
			// mirroring the primary room's `reconcileCameraMute`.
			const onMuteFlip = ifLive(
				(
					publication: {
						source?: string;
						isMuted?: boolean;
						trackSid: string;
						videoTrack?: LocalVideoTrack | RemoteVideoTrack;
					},
					participant: { identity: string },
				) => {
					if (publication.source === "camera") {
						if (publication.isMuted || !publication.videoTrack) {
							deps.removeVideoTrackIfMatches(
								participant.identity,
								publication.trackSid,
							);
							if (
								entry.videoEntries.get(participant.identity) ===
								publication.trackSid
							) {
								entry.videoEntries.delete(participant.identity);
							}
						} else {
							deps.upsertVideoTrack(
								participant.identity,
								publication.videoTrack,
								publication.trackSid,
							);
							entry.videoEntries.set(
								participant.identity,
								publication.trackSid,
							);
						}
					}
					deps.onChanged();
				},
			);
			r.on(lk.RoomEvent.TrackMuted, onMuteFlip);
			r.on(lk.RoomEvent.TrackUnmuted, onMuteFlip);
			r.on(
				lk.RoomEvent.ActiveSpeakersChanged,
				ifLive(() => deps.onChanged()),
			);
			r.on(
				lk.RoomEvent.ParticipantConnected,
				ifLive(() => deps.onRosterChanged()),
			);
			r.on(
				lk.RoomEvent.ParticipantDisconnected,
				ifLive((participant: { identity: string }) => {
					// Purge this origin's media for the departed identity -
					// stale TrackUnsubscribed events may have been swallowed
					// by the disconnect (primary-path behaviour).
					const vidSid = entry.videoEntries.get(participant.identity);
					if (vidSid !== undefined) {
						deps.removeVideoTrackIfMatches(participant.identity, vidSid);
						entry.videoEntries.delete(participant.identity);
					}
					const shareSid = entry.shareEntries.get(participant.identity);
					if (shareSid !== undefined) {
						deps.removeScreenShareTrackIfMatches(
							participant.identity,
							shareSid,
						);
						entry.shareEntries.delete(participant.identity);
					}
					deps.onRosterChanged();
				}),
			);
			r.on(
				lk.RoomEvent.Disconnected,
				ifLive(() => {
					// Unsolicited drop of a foreign room. Mark failed (the
					// membership-tick reconcile retries after the backoff) and
					// reclaim this origin's media + binding. `epoch` bump via
					// teardownEntry makes every remaining handler stale.
					entry.state = "failed";
					entry.failedAt = now();
					void teardownEntry(entry);
					deps.onRosterChanged();
				}),
			);

			if (e2eeCtx) {
				// Same ordering invariant as the primary room: encryption on
				// before the websocket, before any subscription arrives.
				await r.setE2EEEnabled(true);
				if (stale()) {
					await r.disconnect().catch(() => {});
					binding?.release();
					pendingBinding = null;
					return;
				}
			}

			await r.connect(url, jwt);
			if (stale()) {
				await r.disconnect().catch(() => {});
				binding?.release();
				pendingBinding = null;
				return;
			}

			entry.room = r;
			entry.binding = binding;
			pendingBinding = null;
			pendingRoom = null;
			entry.state = "connected";

			// Scan publications that were already subscribed before our
			// listeners attached (in-progress call race, primary-path
			// behaviour).
			for (const p of r.remoteParticipants.values()) {
				for (const pub of p.audioTrackPublications.values()) {
					if (pub.isSubscribed && pub.audioTrack) {
						deps.attachAudioTrack(pub.audioTrack as RemoteAudioTrack, pub);
						entry.audioSids.add(pub.trackSid);
					}
				}
				for (const pub of p.videoTrackPublications.values()) {
					if (!pub.isSubscribed || !pub.videoTrack) continue;
					if (pub.source === "camera") {
						if (pub.isMuted) continue;
						deps.upsertVideoTrack(
							p.identity,
							pub.videoTrack as RemoteVideoTrack,
							pub.trackSid,
						);
						entry.videoEntries.set(p.identity, pub.trackSid);
					} else if (pub.source === "screen_share") {
						deps.upsertScreenShareTrack(
							p.identity,
							pub.videoTrack as RemoteVideoTrack,
							pub.trackSid,
						);
						entry.shareEntries.set(p.identity, pub.trackSid);
					}
				}
			}
			deps.onRosterChanged();
		} catch (e) {
			if (pendingRoom) {
				await pendingRoom.disconnect().catch(() => {});
			}
			pendingBinding?.release();
			if (stale()) return;
			entry.state = "failed";
			entry.failedAt = now();
			// Console-only by design: the peer's row keeps the #494
			// "different server" badge, which is the user-facing signal.
			reportError(e, {
				logLabel: `rtc: foreign SFU connect failed (${entry.origin})`,
			});
			deps.onRosterChanged();
		}
	};

	const reconcile = (desired: ReadonlyMap<string, LivekitTransport>): void => {
		if (disposed) return;
		// Tear down origins no membership publishes to any more.
		for (const [origin, entry] of [...entries]) {
			if (!desired.has(origin)) {
				entries.delete(origin);
				void teardownEntry(entry);
			}
		}
		// Connect new origins; retry failed ones after the backoff.
		for (const [origin, transport] of desired) {
			const existing = entries.get(origin);
			if (!existing) {
				const entry: OriginEntry = {
					origin,
					transport,
					state: "connecting",
					epoch: 0,
					room: null,
					binding: null,
					audioSids: new Set(),
					videoEntries: new Map(),
					shareEntries: new Map(),
					failedAt: 0,
				};
				entries.set(origin, entry);
				void connectOrigin(entry);
				continue;
			}
			if (
				existing.state === "failed" &&
				now() - existing.failedAt >= FOREIGN_RETRY_MS
			) {
				existing.transport = transport;
				existing.state = "connecting";
				existing.epoch++;
				void connectOrigin(existing);
			}
		}
	};

	const rooms = (): ForeignRoomHandle[] =>
		[...entries.values()].map((e) => ({
			origin: e.origin,
			state: e.state,
			room: e.room,
		}));

	const stateOf = (origin: string): ForeignRoomState | undefined =>
		entries.get(origin)?.state;

	const clear = async (): Promise<void> => {
		const all = [...entries.values()];
		entries.clear();
		await Promise.all(all.map((e) => teardownEntry(e)));
	};

	const disposeAll = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		await clear();
	};

	return { reconcile, rooms, stateOf, clear, disposeAll };
}
