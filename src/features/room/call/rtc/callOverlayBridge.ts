import type { Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

/**
 * Cross-window state bridge for the desktop call overlay (the "two-window"
 * model). The main app window owns the MatrixClient and the live call, but the
 * floating always-on-top overlay lives in a *separate* native window that has no
 * client of its own. Because both windows are served from the same origin, a
 * `BroadcastChannel` lets the main window publish a small, serialisable snapshot
 * of the call and lets the overlay mirror it — and lets the overlay send a
 * "leave" command back without ever touching the SDK directly.
 *
 * This is deliberately framework-light: a producer (main window) and a consumer
 * (overlay window) talking over one channel. It is also useful in a plain
 * browser for testing — open `/overlay` in a second tab while in a call.
 *
 * Note: `BroadcastChannel` never delivers a message to the same context that
 * posted it, so the producer's snapshots never echo back to itself, and the
 * consumer's "request"/"leave" messages are only seen by the producer.
 */

const CHANNEL_NAME = "crust:call-overlay";

/** One participant as mirrored to the overlay window. */
export interface CallOverlayParticipant {
	/** LiveKit identity — stable key for the row. */
	identity: string;
	displayName: string;
	/** Resolved (http) avatar URL, or null. Pre-resolved by the producer since
	 *  the overlay window has no client to turn an mxc into a URL. */
	avatarUrl: string | null;
	isLocal: boolean;
	/** Effective mute state: for the local participant this already folds in the
	 *  voice store's push-to-mute/talk override, so the consumer needs no client
	 *  or voice store of its own. */
	isMuted: boolean;
	/** Raw active-speaker flag as reported by LiveKit. The view derives the
	 *  visible "speaking" cue as `isSpeaking && !isMuted`, matching the PiP panel. */
	isSpeaking: boolean;
}

/** A full snapshot of the call as seen by the overlay. */
export interface CallOverlaySnapshot {
	/** False when no call is active (overlay shows an idle state). */
	active: boolean;
	roomName: string;
	participants: readonly CallOverlayParticipant[];
}

/** The snapshot shown before any producer responds / when no call is active. */
export const INACTIVE_SNAPSHOT: CallOverlaySnapshot = {
	active: false,
	roomName: "",
	participants: [],
};

type BridgeMessage =
	| { kind: "snapshot"; producerId: string; snapshot: CallOverlaySnapshot }
	| { kind: "request" }
	| { kind: "command"; command: "leave"; producerId: string };

/** Random id identifying one producer (one main-app window/tab) on the shared
 *  channel, so a consumer can bind to a single producer and ignore others. */
function newProducerId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `p-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Open the shared channel, or null if the runtime lacks BroadcastChannel. */
function openChannel(): BroadcastChannel | null {
	if (typeof BroadcastChannel === "undefined") return null;
	try {
		return new BroadcastChannel(CHANNEL_NAME);
	} catch {
		return null;
	}
}

/** Upper bound on participants accepted from a channel payload — guards the
 *  consumer against an absurd/hostile same-origin message. Real calls are tiny. */
const MAX_PARTICIPANTS = 1000;

function isValidParticipant(value: unknown): value is CallOverlayParticipant {
	if (typeof value !== "object" || value === null) return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.identity === "string" &&
		typeof p.displayName === "string" &&
		(p.avatarUrl === null || typeof p.avatarUrl === "string") &&
		typeof p.isLocal === "boolean" &&
		typeof p.isMuted === "boolean" &&
		typeof p.isSpeaking === "boolean"
	);
}

/**
 * Validate every element of a (possibly sparse) array. Index access yields
 * `undefined` for holes — which `isValidParticipant` rejects — whereas
 * `Array.prototype.every` SKIPS holes and would wrongly accept a sparse array
 * of empty slots that then deref as `undefined` in the view.
 */
function allValidParticipants(arr: readonly unknown[]): boolean {
	for (let i = 0; i < arr.length; i++) {
		if (!isValidParticipant(arr[i])) return false;
	}
	return true;
}

function isValidSnapshot(value: unknown): value is CallOverlaySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const s = value as Record<string, unknown>;
	return (
		typeof s.active === "boolean" &&
		typeof s.roomName === "string" &&
		Array.isArray(s.participants) &&
		s.participants.length <= MAX_PARTICIPANTS &&
		allValidParticipants(s.participants)
	);
}

/**
 * Copy a validated snapshot into fresh plain objects holding ONLY the known
 * fields. This strips any attacker-controlled extra keys on the same-origin
 * payload (e.g. an own `__proto__` key) so they can never reach `reconcile`,
 * whose assignment-based writes would otherwise pollute store prototypes.
 */
function sanitizeSnapshot(s: CallOverlaySnapshot): CallOverlaySnapshot {
	return {
		active: s.active,
		roomName: s.roomName,
		participants: s.participants.map((p) => ({
			identity: p.identity,
			displayName: p.displayName,
			avatarUrl: p.avatarUrl,
			isLocal: p.isLocal,
			isMuted: p.isMuted,
			isSpeaking: p.isSpeaking,
		})),
	};
}

/** Best-effort narrowing of an untrusted channel payload. Snapshots are fully
 *  shape-validated and copied into clean objects before they can reach
 *  `reconcile`, so a malformed or hostile same-origin message is dropped or
 *  sanitised rather than corrupting overlay state. */
function asBridgeMessage(data: unknown): BridgeMessage | null {
	if (typeof data !== "object" || data === null) return null;
	const msg = data as {
		kind?: unknown;
		command?: unknown;
		producerId?: unknown;
		snapshot?: unknown;
	};
	if (msg.kind === "request") return { kind: "request" };
	if (
		msg.kind === "command" &&
		msg.command === "leave" &&
		typeof msg.producerId === "string"
	) {
		return { kind: "command", command: "leave", producerId: msg.producerId };
	}
	if (
		msg.kind === "snapshot" &&
		typeof msg.producerId === "string" &&
		isValidSnapshot(msg.snapshot)
	) {
		return {
			kind: "snapshot",
			producerId: msg.producerId,
			snapshot: sanitizeSnapshot(msg.snapshot),
		};
	}
	return null;
}

export interface CallOverlayProducerHandlers {
	/** Build the current snapshot on demand (used to answer a late "request"). */
	getSnapshot: () => CallOverlaySnapshot;
	/** Invoked when an overlay window asks to leave the call. */
	onLeave: () => void;
}

export interface CallOverlayProducer {
	/** Publish a fresh snapshot to any listening overlay windows. */
	publish: (snapshot: CallOverlaySnapshot) => void;
	/** Tear down the channel. Idempotent. */
	dispose: () => void;
}

/**
 * Create the producer side (main app window). Answers "request" handshakes with
 * the latest snapshot so a newly-opened overlay populates immediately, and
 * honours a "leave" command only when it is addressed to THIS producer's id —
 * so hanging up from an overlay can never end a different tab's call.
 */
export function createCallOverlayProducer(
	handlers: CallOverlayProducerHandlers,
): CallOverlayProducer {
	const channel = openChannel();
	if (!channel) {
		return { publish: () => {}, dispose: () => {} };
	}
	const producerId = newProducerId();
	const post = (snapshot: CallOverlaySnapshot): void => {
		channel.postMessage({
			kind: "snapshot",
			producerId,
			snapshot,
		} satisfies BridgeMessage);
	};
	channel.onmessage = (ev: MessageEvent): void => {
		const msg = asBridgeMessage(ev.data);
		if (!msg) return;
		if (msg.kind === "request") {
			// Only answer when this window actually owns an active call. This
			// keeps idle main-app tabs (which also mount a producer) from
			// clobbering the overlay's handshake with an inactive snapshot that
			// races the calling tab's active one.
			const snapshot = handlers.getSnapshot();
			if (snapshot.active) post(snapshot);
		} else if (msg.kind === "command" && msg.producerId === producerId) {
			handlers.onLeave();
		}
	};
	return {
		publish: post,
		dispose: () => {
			channel.onmessage = null;
			channel.close();
		},
	};
}

export interface CallOverlayConsumer {
	/** Reactive latest snapshot. Starts at `INACTIVE_SNAPSHOT`. */
	snapshot: Accessor<CallOverlaySnapshot>;
	/** Ask the main window to leave the call. */
	sendLeave: () => void;
	/** Tear down the channel. Idempotent. */
	dispose: () => void;
}

/**
 * Create the consumer side (overlay window). Subscribes to snapshots and sends a
 * one-shot "request" so it gets current state without waiting for the next
 * change.
 *
 * Snapshots are merged into a store with `reconcile` keyed by participant
 * identity, so each row keeps a stable object reference across updates. Without
 * this, every broadcast (e.g. an active-speaker change) would hand `<For>` brand
 * new objects and tear down/recreate every row — recreating avatar images and
 * dropping CSS transitions.
 *
 * The consumer binds to the first producer that reports an active call and then
 * ignores other producers, so a second main-app tab (idle or ending its own
 * call) can neither blank the overlay nor receive its "leave". When the bound
 * producer reports inactive, the consumer unbinds and re-requests state to
 * rediscover any other still-active producer.
 */
export function createCallOverlayConsumer(): CallOverlayConsumer {
	const [snapshot, setSnapshot] = createStore<CallOverlaySnapshot>({
		active: false,
		roomName: "",
		participants: [],
	});
	const channel = openChannel();
	if (!channel) {
		return { snapshot: () => snapshot, sendLeave: () => {}, dispose: () => {} };
	}
	let boundProducerId: string | null = null;
	const requestState = (): void => {
		channel.postMessage({ kind: "request" } satisfies BridgeMessage);
	};
	channel.onmessage = (ev: MessageEvent): void => {
		const msg = asBridgeMessage(ev.data);
		if (msg?.kind !== "snapshot") return;
		if (msg.snapshot.active) {
			// Bind to the first active producer; ignore any others.
			if (boundProducerId === null) boundProducerId = msg.producerId;
			if (msg.producerId !== boundProducerId) return;
			setSnapshot(reconcile(msg.snapshot, { key: "identity" }));
		} else {
			// Only the producer we're bound to may clear us.
			if (msg.producerId !== boundProducerId) return;
			boundProducerId = null;
			setSnapshot(reconcile(msg.snapshot, { key: "identity" }));
			requestState();
		}
	};
	requestState();
	return {
		snapshot: () => snapshot,
		sendLeave: () => {
			if (boundProducerId === null) return;
			channel.postMessage({
				kind: "command",
				command: "leave",
				producerId: boundProducerId,
			} satisfies BridgeMessage);
		},
		dispose: () => {
			channel.onmessage = null;
			channel.close();
		},
	};
}
