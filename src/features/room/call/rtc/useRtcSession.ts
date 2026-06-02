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
import { buildFallbackLivekitFoci, discoverLivekitFoci } from "./discoverFoci";
import type { RtcE2EEContext } from "./rtcE2EEBridge";

export type RtcStatus = "idle" | "joining" | "joined" | "leaving" | "error";

export interface UseRtcSessionOptions {
	client: MatrixClient;
	/** Room id the session is for. Snapshotted at hook construction. */
	roomId: string;
	/** Operator-deployed Element Call URL — feeds the EC-bundled foci fallback. */
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
	/**
	 * Test seam — overrides the foci discovery implementation. Defaults to
	 * `discoverLivekitFoci` from `./discoverFoci`, which reads
	 * `org.matrix.msc4143.rtc_foci` from the homeserver's `.well-known`
	 * document and falls back to the EC-bundled derivation.
	 */
	discoverFoci?: (
		client: MatrixClient,
		elementCallUrl: string,
		roomId: string,
		options?: { signal?: AbortSignal },
	) => Promise<LivekitTransport[]>;
}

export interface RtcSessionApi {
	status: Accessor<RtcStatus>;
	memberships: Accessor<readonly CallMembership[]>;
	error: Accessor<Error | null>;
	/** True when the room exists and at least one focus is configured.
	 * Phase 4 lifted the unencrypted-only restriction: encrypted rooms
	 * are joinable once the consumer supplies the E2EE bridge via
	 * `opts.e2ee`. The hook itself does not block on encryption — that
	 * gate lived in Phase 1/2 only. Stays `false` while async foci
	 * discovery is in flight (see `fociReady`). */
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
	/**
	 * Resolves once the async foci discovery (well-known fetch + fallback)
	 * has settled. Surfaced so tests can synchronise on the moment
	 * `canJoin` / `joinBlockReason` reflect the final foci list rather
	 * than the initial "discovering" state. Always resolves; never rejects.
	 */
	fociReady: Promise<void>;
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
 * `unstableSendStickyEvents` MUST stay `false` until `summaries.ts`
 * callActive detection and `CallButton.tsx` learn the newer
 * `m.rtc.member` event format. Current Element Call still accepts the
 * legacy non-hashed identity, so this is non-urgent (tracked in #122).
 */
export function useRtcSession(opts: UseRtcSessionOptions): RtcSessionApi {
	const [status, setStatus] = createSignal<RtcStatus>("idle");
	const [memberships, setMemberships] = createSignal<readonly CallMembership[]>(
		[],
	);
	const [error, setError] = createSignal<Error | null>(null);
	const [session, setSession] = createSignal<MatrixRTCSession | null>(null);

	const room = opts.client.getRoom(opts.roomId);
	// Foci are discovered asynchronously from `.well-known/matrix/client`
	// per MSC4143, falling back to the EC-bundled derivation when the
	// homeserver does not advertise any. `null` while in flight so the
	// UI shows a "Discovering..." block reason instead of trying to join
	// against a half-resolved list.
	const [foci, setFoci] = createSignal<LivekitTransport[] | null>(null);
	const discoverImpl = opts.discoverFoci ?? discoverLivekitFoci;
	// External AbortController so onCleanup can cancel the in-flight
	// well-known fetch on overlay close — otherwise a quickly-opened-
	// and-closed call wastes up to a full 5-second fetch timeout of
	// network work.
	const discoveryAbort =
		typeof AbortController === "function" ? new AbortController() : undefined;
	// Disposed flag so the discovery promise (which still resolves
	// after `discoveryAbort.abort()` via the fallback arm) doesn't
	// write to `foci` after the hook has been disposed.
	let disposed = false;
	// Wrap the override invocation in `Promise.resolve().then(...)` so
	// a synchronously-throwing custom `discoverFoci` is normalised into
	// a rejection and caught by the fallback arm below. A raw
	// `discoverImpl(...)` call would otherwise throw out of hook
	// construction.
	const fociReady: Promise<void> = Promise.resolve()
		.then(() =>
			discoverImpl(opts.client, opts.elementCallUrl, opts.roomId, {
				signal: discoveryAbort?.signal,
			}),
		)
		.then((resolved) => {
			if (disposed) return;
			setFoci(resolved);
		})
		.catch(() => {
			// `discoverLivekitFoci` never throws, but a custom override
			// might (sync throw or async rejection). Fall back to the
			// EC-bundled derivation rather than leaving `foci()`
			// permanently null and blocking Join.
			if (disposed) return;
			setFoci(buildFallbackLivekitFoci(opts.elementCallUrl, opts.roomId));
		});
	let leavePending = false;

	const joinBlockReason = createMemo((): string | null => {
		if (!room) return `Room ${opts.roomId} not found in client store`;
		const list = foci();
		if (list === null) {
			return "Discovering MatrixRTC focus…";
		}
		if (list.length === 0) {
			return "No MatrixRTC foci configured — set elementCall.url in config.json or publish org.matrix.msc4143.rtc_foci in .well-known/matrix/client.";
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
		const fociList = foci();
		return fociList && fociList.length > 0 ? fociList[0] : null;
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
			// SDK-driven leaves (kicked, network failure, manager-internal
			// teardown) hit this path without going through our `leave()`,
			// so detach the E2EE listener and bump `joinEpoch` to invalidate
			// any in-flight key event from the departing RTCEncryptionManager.
			// `leavePending` defers to `leave()`'s own cleanup path.
			if (!isJoined && !leavePending && detachE2EE !== null) {
				detachE2EE();
				detachE2EE = null;
				joinEpoch++;
			}
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
			const stillJoined = s.isJoined();
			setStatus(stillJoined ? "joined" : "error");
			// If the async failure means we never actually joined, run the
			// same E2EE cleanup the synchronous catch arm in `join()` runs:
			// detach the listener attached BEFORE joinRoomSession and bump
			// `joinEpoch` so a late EncryptionKeyChanged event (the SDK can
			// still emit one before tearing down the RTCEncryptionManager)
			// bails on its `isLive` check instead of pumping a key from the
			// failed session into the LiveKit keyProvider.
			if (!stillJoined && detachE2EE !== null) {
				detachE2EE();
				detachE2EE = null;
				joinEpoch++;
			}
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
	// Re-entrancy guard for join(): a double-click (or two effects firing)
	// while foci discovery is still pending would otherwise have both
	// invocations pass the synchronous `s.isJoined()` check, park on
	// `await fociReady`, and then both run the attach+joinRoomSession
	// body — leaking the first E2EE listener and double-invoking
	// joinRoomSession. Set before the first `await` so the second caller
	// short-circuits.
	let joinInFlight = false;
	// Ownership token for the joinInFlight slot. Bumped by every join()
	// attempt AND by every cancel path. The owning join() compares its
	// captured token in `finally`: if the token still matches, it clears
	// joinInFlight; if it doesn't, a cancel (and possibly a fresh join())
	// has happened in the meantime and we must not stomp the new owner's
	// flag.
	let joinAttemptId = 0;

	const join = async (): Promise<void> => {
		const s = session();
		if (!s) {
			setError(new Error("Session not initialised"));
			setStatus("error");
			return;
		}
		if (s.isJoined()) return;
		if (status() === "joining") return;
		if (joinInFlight) return;
		joinInFlight = true;
		const myAttempt = ++joinAttemptId;
		// Snapshot the join epoch so leave()/onCleanup() can cancel a
		// join attempt parked on `await fociReady` by bumping the
		// epoch (which they already do in every relevant path —
		// leave()'s early-return arm at line ~402, leave()'s success/
		// non-joined error arms, and onCleanup unconditionally). If
		// the epoch advanced while we were parked, the user closed
		// the overlay or hit Leave and we must NOT call
		// joinRoomSession after the fact.
		const startEpoch = joinEpoch;
		try {
			await joinInner(s, startEpoch);
		} finally {
			// Only release the slot if we still own it. Cancel paths
			// bump joinAttemptId AND clear joinInFlight to unblock a
			// follow-up Join click; a fresh join() may have already
			// grabbed the slot with a higher joinAttemptId.
			if (joinAttemptId === myAttempt) {
				joinInFlight = false;
			}
		}
	};

	const joinInner = async (
		s: MatrixRTCSession,
		startEpoch: number,
	): Promise<void> => {
		// Wait for async foci discovery to settle before evaluating the
		// block reason — otherwise a quick Join click would race the
		// well-known fetch and hit the "Discovering…" block path.
		if (foci() === null) {
			await fociReady;
		}
		// Cancelled while we were parked: leave() or onCleanup bumped
		// joinEpoch. Bail before publishing a membership the user
		// already asked us not to.
		if (joinEpoch !== startEpoch) return;
		// Re-check after the await: the session may have been joined
		// (e.g. by a separately-resolved code path) while we were
		// parked.
		if (s.isJoined()) return;
		// Also re-check status: another in-flight join may have called
		// joinRoomSession (fire-and-forget) and returned before the SDK
		// flipped isJoined; status === "joining" reflects that window.
		if (status() === "joining") return;
		// Defensive re-check — defends against `room` being null at
		// hook-init time (Phase 1 set status="error" but kept the hook
		// alive so a later getRoom hit would still expose canJoin).
		const blockReason = joinBlockReason();
		if (blockReason !== null) {
			setError(new Error(blockReason));
			setStatus("error");
			return;
		}
		// Snapshot the resolved foci list — `joinBlockReason === null`
		// guarantees this is non-null and non-empty.
		const fociList = foci() as LivekitTransport[];
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
			s.joinRoomSession(fociList, undefined, {
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
			// imports bail before reaching the keyProvider. Also clear
			// joinInFlight so a re-Join click after this cancel isn't
			// silently swallowed by the re-entrancy guard while the
			// parked joinInner (which we just told to bail via the
			// epoch bump) is still waiting on fociReady.
			joinEpoch++;
			joinAttemptId++;
			joinInFlight = false;
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
			joinAttemptId++;
			joinInFlight = false;
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
				joinAttemptId++;
				joinInFlight = false;
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
		disposed = true;
		discoveryAbort?.abort();
		detachE2EE?.();
		detachE2EE = null;
		joinEpoch++;
		joinAttemptId++;
		joinInFlight = false;
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
		fociReady,
		join,
		leave,
	};
}
