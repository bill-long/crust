import type { MatrixClient } from "matrix-js-sdk";
import type {
	CallMembership,
	LivekitTransport,
} from "matrix-js-sdk/lib/matrixrtc";
import {
	type MatrixRTCSession,
	MatrixRTCSessionEvent,
} from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import {
	type Accessor,
	createEffect,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { buildFallbackLivekitFoci } from "./discoverFoci";

export type RtcStatus = "idle" | "joining" | "joined" | "leaving" | "error";

export interface UseRtcSessionOptions {
	client: MatrixClient;
	/** Room id the session is for. Snapshotted at hook construction. */
	roomId: string;
	/** Operator-deployed Element Call URL — feeds Phase-1 foci fallback. */
	elementCallUrl: string;
}

export interface RtcSessionApi {
	status: Accessor<RtcStatus>;
	memberships: Accessor<readonly CallMembership[]>;
	error: Accessor<Error | null>;
	/** True when the room exists and at least one focus is configured. */
	canJoin: Accessor<boolean>;
	join: () => Promise<void>;
	leave: () => Promise<void>;
}

/**
 * Phase 1 of the native MatrixRTC client (issue #122).
 *
 * Wraps `client.matrixRTC.getRoomSession(room)` in a SolidJS hook that
 * exposes join status and the current membership list. This phase publishes
 * the legacy `org.matrix.msc3401.call.member` state event ONLY — no media
 * transport is opened, no encryption keys exchanged, no sticky events sent.
 * That isolation is deliberate so callActive in `src/client/summaries.ts`
 * (which only parses the legacy event) keeps working, and the to-device
 * key path (the Phase-4 crypto boundary) stays quiet.
 *
 * The two guardrail join-config flags below must NOT be flipped to their
 * defaults without an accompanying change in `summaries.ts` and a Phase-4
 * E2EE plan in #122.
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

	const [canJoin, setCanJoin] = createSignal(room !== null && foci.length > 0);

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
		setCanJoin(foci.length > 0);
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

	const join = async (): Promise<void> => {
		const s = session();
		if (!s) {
			setError(new Error("Session not initialised"));
			setStatus("error");
			return;
		}
		if (s.isJoined()) return;
		if (foci.length === 0) {
			setError(
				new Error(
					"No MatrixRTC foci available — set elementCall.url in config.",
				),
			);
			setStatus("error");
			return;
		}
		setError(null);
		setStatus("joining");
		try {
			// Phase 1 guardrails:
			//   manageMediaKeys=false        keeps the to-device encryption path
			//                                quiet until Phase 4 lands E2EE.
			//   unstableSendStickyEvents=false
			//                                keeps writing legacy
			//                                org.matrix.msc3401.call.member state
			//                                events so summaries.ts callActive
			//                                detection keeps working.
			// joinRoomSession is fire-and-forget; this try/catch only covers
			// synchronous validation throws. Async join failures arrive via
			// MembershipManagerError → onManagerError.
			s.joinRoomSession(foci as LivekitTransport[], undefined, {
				manageMediaKeys: false,
				unstableSendStickyEvents: false,
			});
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
			setStatus("error");
		}
	};

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
			return;
		}
		leavePending = true;
		setError(null);
		setStatus("leaving");
		try {
			await s.leaveRoomSession(5_000);
			setStatus("idle");
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
			// If the SDK still reports we're joined, leave the user a path back
			// to retry via the Leave button instead of stranding on "error".
			setStatus(s.isJoined() ? "joined" : "error");
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
		const s = session();
		if (!s || leavePending) return;
		if (s.isJoined() || status() === "joining") {
			void s.leaveRoomSession(5_000).catch(() => {
				/* swallow — component is gone, nowhere to surface this */
			});
		}
	});

	return { status, memberships, error, canJoin, join, leave };
}
