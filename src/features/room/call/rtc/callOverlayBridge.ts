import type { Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

/**
 * Read-only cross-window display state. BroadcastChannel peers are untrusted:
 * call control travels through native IPC, whose caller window Tauri verifies.
 * The producer heartbeat expires stale state after a main-window crash.
 */

const CHANNEL_NAME = "crust:call-overlay";
const HEARTBEAT_MS = 5_000;
// Tolerate the one-minute timer throttling of a background browser preview.
export const OVERLAY_LEASE_MS = 90_000;

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
	/** True when no call membership matched the LiveKit identity, so
	 *  `displayName` is the neutral "Unknown (prefix…)" fallback and
	 *  `identity` doubles as a debugging tooltip (#488). */
	isUnresolved: boolean;
	/** True when the participant publishes media to a different SFU than the
	 *  one we joined - used only to word the `micUnavailable` cue (#488). */
	isForeignSfu: boolean;
	/** True when `isMuted` is a no-publication artifact for a foreign or
	 *  unresolved peer; the view shows "audio unavailable" instead of a
	 *  muted mic (#488). */
	micUnavailable: boolean;
}

/** The additive #488 fields: absent from producers bundled before them (a
 *  main tab open across a deploy). Optional only in the WIRE shape below;
 *  `sanitizeSnapshot` defaults them to false so every consumer downstream
 *  of validation sees concrete booleans and never re-coerces. */
type AdditiveParticipantField =
	| "isUnresolved"
	| "isForeignSfu"
	| "micUnavailable";

/** What may arrive over the channel: the current participant shape with the
 *  additive fields possibly missing. Internal - consumers only ever see the
 *  sanitized `CallOverlayParticipant`. */
type WireCallOverlayParticipant = Omit<
	CallOverlayParticipant,
	AdditiveParticipantField
> &
	Partial<Pick<CallOverlayParticipant, AdditiveParticipantField>>;

/** A full snapshot of the call as seen by the overlay. */
export interface CallOverlaySnapshot {
	/** False when no call is active (overlay shows an idle state). */
	active: boolean;
	roomName: string;
	participants: readonly CallOverlayParticipant[];
}

/** Wire form of a snapshot; see `WireCallOverlayParticipant`. */
type WireCallOverlaySnapshot = Omit<CallOverlaySnapshot, "participants"> & {
	participants: readonly WireCallOverlayParticipant[];
};

/** The snapshot shown before any producer responds / when no call is active. */
export const INACTIVE_SNAPSHOT: CallOverlaySnapshot = {
	active: false,
	roomName: "",
	participants: [],
};

type BridgeMessage =
	| { kind: "snapshot"; producerId: string; snapshot: CallOverlaySnapshot }
	| { kind: "request" }
	| { kind: "heartbeat"; producerId: string };

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

function isValidParticipant(
	value: unknown,
): value is WireCallOverlayParticipant {
	if (typeof value !== "object" || value === null) return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.identity === "string" &&
		typeof p.displayName === "string" &&
		(p.avatarUrl === null || typeof p.avatarUrl === "string") &&
		typeof p.isLocal === "boolean" &&
		typeof p.isMuted === "boolean" &&
		typeof p.isSpeaking === "boolean" &&
		// The #488 fields are additive: a snapshot from a producer bundled
		// before they existed (main tab open across a deploy) must still
		// validate, or the overlay would silently show "no active call" for
		// the whole call. `sanitizeSnapshot` defaults them to false.
		(p.isUnresolved === undefined || typeof p.isUnresolved === "boolean") &&
		(p.isForeignSfu === undefined || typeof p.isForeignSfu === "boolean") &&
		(p.micUnavailable === undefined || typeof p.micUnavailable === "boolean")
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

function isValidSnapshot(value: unknown): value is WireCallOverlaySnapshot {
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
function sanitizeSnapshot(s: WireCallOverlaySnapshot): CallOverlaySnapshot {
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
			// Default the additive #488 fields for old-producer snapshots
			// (see isValidParticipant) - `=== true` also normalizes them.
			isUnresolved: p.isUnresolved === true,
			isForeignSfu: p.isForeignSfu === true,
			micUnavailable: p.micUnavailable === true,
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
		producerId?: unknown;
		snapshot?: unknown;
	};
	if (msg.kind === "request") return { kind: "request" };
	if (msg.kind === "heartbeat" && typeof msg.producerId === "string") {
		return { kind: "heartbeat", producerId: msg.producerId };
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
 * sends heartbeats while active. It never accepts call-control commands.
 */
export function createCallOverlayProducer(
	handlers: CallOverlayProducerHandlers,
): CallOverlayProducer {
	const channel = openChannel();
	if (!channel) {
		return { publish: () => {}, dispose: () => {} };
	}
	const producerId = newProducerId();
	let active = false;
	let disposed = false;
	const heartbeat = setInterval(() => {
		if (active)
			channel.postMessage({
				kind: "heartbeat",
				producerId,
			} satisfies BridgeMessage);
	}, HEARTBEAT_MS);
	const post = (snapshot: CallOverlaySnapshot): void => {
		if (disposed) return;
		active = snapshot.active;
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
		}
	};
	return {
		publish: post,
		dispose: () => {
			disposed = true;
			clearInterval(heartbeat);
			channel.onmessage = null;
			channel.close();
		},
	};
}

export interface CallOverlayConsumer {
	/** Reactive latest snapshot. Starts at `INACTIVE_SNAPSHOT`. */
	snapshot: Accessor<CallOverlaySnapshot>;
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
 * ignores other producers, so a second main-app tab cannot blank it. When the bound
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
		return { snapshot: () => snapshot, dispose: () => {} };
	}
	let boundProducerId: string | null = null;
	let lease: ReturnType<typeof setTimeout> | undefined;
	const renewLease = (): void => {
		clearTimeout(lease);
		lease = setTimeout(() => {
			boundProducerId = null;
			setSnapshot(reconcile(INACTIVE_SNAPSHOT));
			requestState();
		}, OVERLAY_LEASE_MS);
	};
	const requestState = (): void => {
		channel.postMessage({ kind: "request" } satisfies BridgeMessage);
	};
	channel.onmessage = (ev: MessageEvent): void => {
		const msg = asBridgeMessage(ev.data);
		if (msg?.kind === "heartbeat") {
			if (msg.producerId === boundProducerId) renewLease();
			else if (boundProducerId === null) requestState();
			return;
		}
		if (msg?.kind !== "snapshot") return;
		if (msg.snapshot.active) {
			// Bind to the first active producer; ignore any others.
			if (boundProducerId === null) boundProducerId = msg.producerId;
			if (msg.producerId !== boundProducerId) return;
			renewLease();
			setSnapshot(reconcile(msg.snapshot, { key: "identity" }));
		} else {
			// Only the producer we're bound to may clear us.
			if (msg.producerId !== boundProducerId) return;
			boundProducerId = null;
			clearTimeout(lease);
			setSnapshot(reconcile(msg.snapshot, { key: "identity" }));
			requestState();
		}
	};
	requestState();
	return {
		snapshot: () => snapshot,
		dispose: () => {
			clearTimeout(lease);
			channel.onmessage = null;
			channel.close();
		},
	};
}
