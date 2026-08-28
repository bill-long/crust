import { createSignal } from "solid-js";

/** A transient app-level notice (toast). `tone` drives styling only. */
export interface Notice {
	id: number;
	message: string;
	tone: "info" | "error";
}

const [notices, setNotices] = createSignal<Notice[]>([]);

// Monotonic id for stable dismissal and deterministic tests. (Solid's <For>
// keys by object identity, not this field.) A plain counter, not Date.now/random
// (unavailable in some contexts and non-deterministic in tests).
let nextId = 0;

export { notices };

/**
 * Show a transient notice (rendered by NoticeToasts at the app root, so it
 * survives room/route changes and a disposed emitter). Returns the notice id.
 */
export function pushNotice(
	message: string,
	tone: Notice["tone"] = "info",
): number {
	nextId += 1;
	const id = nextId;
	setNotices((prev) => [...prev, { id, message, tone }]);
	return id;
}

/** Remove a notice by id (manual dismiss or auto-dismiss timeout). */
export function dismissNotice(id: number): void {
	setNotices((prev) => prev.filter((n) => n.id !== id));
}

/**
 * A notice queued for the session that has not started yet, held outside
 * {@link notices} so the handover below is the only thing that can deliver it.
 */
let carried: Pick<Notice, "message" | "tone"> | null = null;

/**
 * Remove all notices, including one queued by {@link carryNoticeIntoSession}
 * that no session has taken delivery of. "All" means all: a caller clearing up
 * cannot be expected to know that a second, invisible slot exists.
 */
export function clearNotices(): void {
	setNotices([]);
	carried = null;
}

/**
 * Queue a notice to be shown once the app root is up, rather than now.
 *
 * The renderer lives inside the authenticated shell, and it drops whatever it
 * finds when it mounts (see {@link takeCarriedNotice}). Anything pushed from
 * outside a session - the login route's guard, which by definition runs before
 * one exists (#549) - would therefore be cleared before it was ever painted.
 * This is the way in for a message that is ABOUT the session being entered.
 *
 * One slot, last write wins: these are pushed at a single decision point on the
 * way in, so there is never a second.
 */
export function carryNoticeIntoSession(
	message: string,
	tone: Notice["tone"] = "info",
): void {
	carried = { message, tone };
}

/**
 * Take the notice queued for the session that is starting, or null. One-shot.
 *
 * The app-root renderer calls this as it mounts, then pushes what it gets -
 * WHEN it pushes is the renderer's business, not the store's: the container is
 * an `aria-live` region, and a region only announces mutations that happen
 * after it has been registered.
 */
export function takeCarriedNotice(): Pick<Notice, "message" | "tone"> | null {
	const entry = carried;
	carried = null;
	return entry;
}
