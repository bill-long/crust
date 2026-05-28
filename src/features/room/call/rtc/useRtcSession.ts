import type { MatrixClient } from "matrix-js-sdk";
import type {
	CallMembership,
	LivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc";
import { isLivekitTransport } from "matrix-js-sdk/lib/matrixrtc/LivekitTransport";
import {
	type MatrixRTCSession,
	MatrixRTCSessionEvent,
} from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { buildFallbackLivekitFoci } from "./discoverFoci";
import type { RtcE2EEContext } from "./rtcE2EEBridge";

export type RtcStatus = "idle" | "joining" | "joined" | "leaving" | "error";

export interface UseRtcSessionOptions {
	client: MatrixClient;
	/** Room id the session is for. Snapshotted at hook construction. */
	roomId: string;
	/** Operator-deployed Element Call URL — feeds Phase-1 foci fallback. */
	elementCallUrl: string;
	/**
	 * Phase 4 E2EE bridge. When present and non-null, the hook attaches
	 * the bridge listener BEFORE `joinRoomSession`, flips
	 * `manageMediaKeys: true` so the SDK runs the to-device key
	 * transport, and calls `reemitEncryptionKeys()` AFTER attach to
	 * flush any already-negotiated keys through the wire. When null/
	 * undefined, the hook stays on the Phase-1/2 quiet-crypto path.
	 */
	e2ee?: Accessor<RtcE2EEContext | null>;
}

export interface RtcSessionApi {
	status: Accessor<RtcStatus>;
	memberships: Accessor<readonly CallMembership[]>;
	error: Accessor<Error | null>;
	/** True when the room exists and at least one focus is configured.
	 * Phase 4 lifted the unencrypted-only restriction: encrypted rooms
	 * are joinable once the consumer supplies the E2EE bridge via
	 * `opts.e2ee`. The hook itself does not block on encryption — that
	 * gate lived in Phase 1/2 only. */
	canJoin: Accessor<boolean>;
	/** Human-readable reason Join is blocked, or null when joinable. */
	joinBlockReason: Accessor<string | null>;
	/**
	 * The LiveKit transport that Phase 2 media should dial. Resolves to the
	 * oldest existing member's transport when joining an in-progress call,
	 * or our offered fallback when we are the first participant. Null until
	 * we have joined (no transport to dial before then).
	 */
	activeFocus: Accessor<LivekitTransport | null>;
	join: () => Promise<void>;
	leave: () => Promise<void>;
}

/**
 * Native MatrixRTC client hook (issue #122).
 *
 * Wraps `client.matrixRTC.getRoomSession(room)` in a SolidJS hook that
 * exposes join status and the current membership list. Without the
 * Phase-4 `e2ee` option the hook stays on the legacy
 * `org.matrix.msc3401.call.member` state event with the to-device key
 * path quiet — preserving the Phase-1/2 isolation. When `e2ee` is
 * supplied, the hook attaches the bridge before joinRoomSession,
 * flips `manageMediaKeys: true`, and pumps already-negotiated keys via
 * `reemitEncryptionKeys()` after the manager has spun up.
 *
 * `unstableSendStickyEvents` MUST stay `false` until Phase 5 teaches
 * `summaries.ts` callActive detection and `CallButton.tsx` to read the
 * newer `m.rtc.member` format.
 */
export function useRtcSession(opts: UseRtcSessionOptions): RtcSessionApi {
	const [status, setStatus] = createSignal<RtcStatus>("idle");
	const [memberships, setMemberships] = createSignal<readonly CallMembership[]>(
		[],
	);
	const [error, setError] = createSignal<Error | null>(null);
	const [session, setSession] = createSignal<MatrixRTCSession | null>(null);

	const room = opts.client.getRoom(opts.roomId);
	const foci = buildFallbackLivekitFoci(opts.elementCallUrl, opts.roomId);
	let leavePending = false;

	const joinBlockReason = createMemo((): string | null => {
		if (!room) return `Room ${opts.roomId} not found in client store`;
		if (foci.length === 0) {
			return "No MatrixRTC foci configured — set elementCall.url in config.json.";
		}
		return null;
	});

	const canJoin = createMemo(() => joinBlockReason() === null);

	const activeFocus = createMemo((): LivekitTransport | null => {
		if (status() !== "joined") return null;
		const list = memberships();
		// Pull the oldest member's transport when joining an in-progress call;
		// fall back to our offered focus if we are the first or the oldest
		// member's transport isn't LiveKit.
		const oldest = list.reduce<CallMembership | null>((acc, m) => {
			if (acc === null) return m;
			return m.createdTs() < acc.createdTs() ? m : acc;
		}, null);
		if (oldest) {
			const transport = oldest.getTransport(oldest);
			if (transport && isLivekitTransport(transport)) {
				return transport;
			}
		}
		return foci.length > 0 ? foci[0] : null;
	});

	onMount(() => {
		if (!room) {
			setError(new Error(`Room ${opts.roomId} not found in client store`));
			setStatus("error");
			return;
		}
		const s = opts.client.matrixRTC.getRoomSession(room);
		setSession(s);
		setMemberships([...s.memberships]);
		setStatus(s.isJoined() ? "joined" : "idle");
	});

	createEffect(() => {
		const s = session();
		if (!s) return;

		const onMembershipsChanged = (
			_old: CallMembership[],
			next: CallMembership[],
		): void => {
			setMemberships([...next]);
		};
		const onJoinStateChanged = (isJoined: boolean): void => {
			setStatus((prev) => {
				if (isJoined) return "joined";
				// Defer to leave()'s finally/catch when it's driving the
				// transition — otherwise the catch-arm "error" status would be
				// silently overwritten here.
				if (leavePending) return prev;
				// Preserve "error" so a join failure (MembershipManagerError +
				// JoinStateChanged(false)) doesn't mask the reason from the UI.
				if (prev === "joined" || prev === "leaving" || prev === "joining")
					return "idle";
				return prev;
			});
		};
		const onManagerError = (err: unknown): void => {
			// If a leave is in flight, defer to leave()'s try/catch which is
			// the authoritative driver of error/status during the leave. An
			// asynchronous manager error fired mid-leave (e.g. transient retry)
			// would otherwise leave a stale error after a successful leave
			// settles status to "idle".
			if (leavePending) return;
			setError(err instanceof Error ? err : new Error(String(err)));
			// Keep status aligned with actual joined state so the UI doesn't
			// hide the Leave button while the session is still joined.
			setStatus(s.isJoined() ? "joined" : "error");
		};

		s.on(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
		s.on(MatrixRTCSessionEvent.JoinStateChanged, onJoinStateChanged);
		s.on(MatrixRTCSessionEvent.MembershipManagerError, onManagerError);

		onCleanup(() => {
			s.off(MatrixRTCSessionEvent.MembershipsChanged, onMembershipsChanged);
			s.off(MatrixRTCSessionEvent.JoinStateChanged, onJoinStateChanged);
			s.off(MatrixRTCSessionEvent.MembershipManagerError, onManagerError);
		});
	});

	// Detach fn returned by `e2ee.attach(...)`. Stored on the closure so
	// `leave()` and the unmount cleanup tear it down even if the user
	// never clicked Leave (component closes mid-call). Cleared after
	// every detach so a double-leave doesn't off() a stale listener.
	let detachE2EE: (() => void) | null = null;
	// Bumped on each join attempt; the e2ee `isLive` closure compares
	// against the captured value so a stale key event arriving after
	// Leave (or a superseded Join attempt) bails before it pumps a key
	// from the wrong session into the bridge.
	let joinEpoch = 0;

	const join = async (): Promise<void> => {
		const s = session();
		if (!s) {
			setError(new Error("Session not initialised"));
			setStatus("error");
			return;
		}
		if (s.isJoined()) return;
		// Defensive re-check — defends against `room` being null at
		// hook-init time (Phase 1 set status="error" but kept the hook
		// alive so a later getRoom hit would still expose canJoin).
		const blockReason = joinBlockReason();
		if (blockReason !== null) {
			setError(new Error(blockReason));
			setStatus("error");
			return;
		}
		setError(null);
		setStatus("joining");
		const myEpoch = ++joinEpoch;
		const ctx = opts.e2ee?.() ?? null;
		// Attach the E2EE listener BEFORE joinRoomSession so the bridge
		// catches the initial EncryptionKeyChanged burst from the
		// RTCEncryptionManager. Store detach immediately so a synchronous
		// throw from joinRoomSession (validation) doesn't leak the
		// listener — the catch arm runs detach below.
		if (ctx) {
			detachE2EE = ctx.attach(s, () => joinEpoch === myEpoch);
		}
		try {
			// Phase 4 join config:
			//   manageMediaKeys: true (with e2ee) enables the to-device
			//     key transport so the RTCEncryptionManager exchanges
			//     keys with peers and emits EncryptionKeyChanged.
			//   manageMediaKeys: false (no e2ee) keeps the Phase-1 quiet
			//     path so callers without a bridge don't accidentally
			//     start the crypto path.
			//   unstableSendStickyEvents: false stays until Phase 5 lands
			//     the newer m.rtc.member format in summaries.ts /
			//     CallButton.tsx — keeps legacy callActive detection
			//     working.
			// joinRoomSession is fire-and-forget; this try/catch only covers
			// synchronous validation throws. Async join failures arrive via
			// MembershipManagerError → onManagerError.
			s.joinRoomSession(foci as LivekitTransport[], undefined, {
				manageMediaKeys: ctx !== null,
				unstableSendStickyEvents: false,
			});
			// Pump any keys already negotiated through the bridge AFTER
			// joinRoomSession (which spins up the RTCEncryptionManager).
			// Reemitting earlier would no-op because the manager doesn't
			// exist yet.
			if (ctx) ctx.reemit(s);
		} catch (e) {
			// Synchronous throw: detach the listener we just attached so
			// the next Join attempt isn't competing with a stale one, and
			// bump the epoch so any EncryptionKeyChanged event that snuck
			// into the queue before detach bails on its `isLive` check.
			detachE2EE?.();
			detachE2EE = null;
			joinEpoch++;
			setError(e instanceof Error ? e : new Error(String(e)));
			setStatus("error");
		}
	};

	// Late-arriving bridge attach: when the parent reopens the overlay
	// while MatrixRTC is already joined (close-without-leave flow, hot
	// reload, programmatic close that bypassed requestClose), the parent
	// builds an E2EE ctx through its own recovery effect AFTER `join()`
	// has already short-circuited on `s.isJoined()`. Without this, the
	// fresh ctx would never have `attach()` or `reemit()` called and the
	// LiveKit Room would publish/decode against an empty keyProvider.
	//
	// Guard `detachE2EE === null` so a normal Join click — which sets
	// `e2ee()` first, then calls `join()` synchronously — does not race
	// this effect into a double-attach: the JoinStateChanged listener
	// flips status to "joined" only AFTER `join()` has already assigned
	// `detachE2EE`, so this effect bails.
	createEffect(() => {
		const s = session();
		if (!s) return;
		const ctx = opts.e2ee?.() ?? null;
		if (!ctx) return;
		if (status() !== "joined") return;
		if (detachE2EE !== null) return;
		if (!s.isJoined()) return;
		const myEpoch = ++joinEpoch;
		detachE2EE = ctx.attach(s, () => joinEpoch === myEpoch);
		// Pump any keys the RTCEncryptionManager has already negotiated
		// from before this bridge existed, so the LiveKit keyProvider
		// has a populated keyCache by the time `bindRoom()` replays it
		// on connect.
		ctx.reemit(s);
	});

	const leave = async (): Promise<void> => {
		const s = session();
		if (!s) return;
		if (leavePending) return;
		// Treat "joining" as needing a leave attempt too — joinRoomSession is
		// fire-and-forget, so a close during pending join must still tear down
		// any membership that has already been published or will be published.
		const wasJoining = status() === "joining";
		if (!s.isJoined() && !wasJoining) {
			setStatus("idle");
			// Still detach any E2EE listener — Join may have attached one
			// even though no membership made it out.
			detachE2EE?.();
			detachE2EE = null;
			// Invalidate the current join attempt so any in-flight key
			// imports bail before reaching the keyProvider.
			joinEpoch++;
			return;
		}
		leavePending = true;
		setError(null);
		setStatus("leaving");
		try {
			await s.leaveRoomSession(5_000);
			// Successful leave → detach the bridge and bump epoch so any
			// in-flight key import bails. Doing this AFTER (not before)
			// the await means an error path with `s.isJoined()` still
			// true can keep the bridge wired (see catch arm below) so
			// the user's still-live call doesn't silently drop key
			// updates while they decide whether to retry Leave.
			detachE2EE?.();
			detachE2EE = null;
			joinEpoch++;
			setStatus("idle");
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
			if (s.isJoined()) {
				// Call still alive — keep the bridge attached AND keep
				// `joinEpoch` so EncryptionKeyChanged events continue
				// flowing through to LiveKit. The user can retry Leave
				// from the dialog without us silently breaking E2EE.
				setStatus("joined");
			} else {
				// SDK confirms we're no longer joined — safe to detach.
				detachE2EE?.();
				detachE2EE = null;
				joinEpoch++;
				setStatus("error");
			}
		} finally {
			leavePending = false;
		}
	};

	onCleanup(() => {
		// User intent on overlay unmount is "stop participating". Fire-and-forget;
		// the SDK retries delivery and has a server-side delayed-leave fallback.
		// Guard with leavePending so an explicit leave() that's still in-flight
		// when the component unmounts isn't double-fired here. Also leave when
		// we're still in "joining" so a close-during-join doesn't strand a
		// membership published moments later.
		detachE2EE?.();
		detachE2EE = null;
		joinEpoch++;
		const s = session();
		if (!s || leavePending) return;
		if (s.isJoined() || status() === "joining") {
			void s.leaveRoomSession(5_000).catch(() => {
				/* swallow — component is gone, nowhere to surface this */
			});
		}
	});

	return {
		status,
		memberships,
		error,
		canJoin,
		joinBlockReason,
		activeFocus,
		join,
		leave,
	};
}
