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

/** Remove all notices. */
export function clearNotices(): void {
	setNotices([]);
}
