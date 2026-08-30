import {
	type EventTimelineSet,
	type MatrixClient,
	MatrixEvent,
	MatrixEventEvent,
	type Room,
} from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { displayNameOr } from "../../../lib/displayName";
import { reportError } from "../../../lib/reportError";
import { threadJumpTarget } from "../../../lib/threadEvents";
import { MessageBody } from "../../emoji/MessageBody";
import type { ResolvedEmote } from "../../emoji/types";

export interface ResolvedPinnedEvent {
	event: MatrixEvent;
	sender: string;
	senderName: string;
	timestamp: number;
	body: string;
	format: string | null;
	formattedBody: string | null;
	msgtype: string;
}

/** Identity-stable comparator for resolved projections: equal when every
 *  projected field is unchanged. Lets the memos below return fresh objects
 *  without remounting the row's keyed <Show> subtree on every tick (a
 *  remount re-sanitizes the body and drops keyboard focus mid-burst). */
function sameResolved(
	a: ResolvedPinnedEvent | null,
	b: ResolvedPinnedEvent | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.event === b.event &&
		a.body === b.body &&
		a.msgtype === b.msgtype &&
		a.format === b.format &&
		a.formattedBody === b.formattedBody &&
		a.senderName === b.senderName &&
		a.timestamp === b.timestamp
	);
}

function resolveSync(room: Room, eventId: string): ResolvedPinnedEvent | null {
	const ev = room.findEventById(eventId);
	if (!ev) return null;
	return projectEvent(room, ev);
}

function projectEvent(room: Room, ev: MatrixEvent): ResolvedPinnedEvent {
	const sender = ev.getSender() ?? "";
	const member = sender ? room.getMember(sender) : null;
	const content = (ev.getContent?.() ?? {}) as Record<string, unknown>;
	const body = typeof content.body === "string" ? content.body : "";
	const format = typeof content.format === "string" ? content.format : null;
	const formattedBody =
		typeof content.formatted_body === "string" ? content.formatted_body : null;
	const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
	return {
		event: ev,
		sender,
		senderName: displayNameOr(member?.name, sender),
		timestamp: ev.getTs?.() ?? 0,
		body,
		format,
		formattedBody,
		msgtype,
	};
}

/** Last-resort resolve for events outside every cached timeline (in
 *  practice: pinned thread replies). Returns null on any failure so the
 *  row falls back to "(message unavailable)". */
async function fetchStandalone(
	client: MatrixClient,
	room: Room,
	eventId: string,
): Promise<ResolvedPinnedEvent | null> {
	try {
		const raw = await client.fetchRoomEvent(room.roomId, eventId);
		if (!raw?.event_id) return null;
		const event = new MatrixEvent(raw);
		// No-op for unencrypted events; decrypts with cached keys otherwise
		// (a bare fetched event is never scheduled for decryption by the
		// SDK). Mirrors ensureThread's root fetch.
		await client.decryptEventIfNeeded(event);
		return projectEvent(room, event);
	} catch {
		return null;
	}
}

function formatPinnedTime(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

const PinnedMessageRow: Component<{
	client: MatrixClient;
	room: Room;
	eventId: string;
	/** Panel-level tick: bumps when THIS room's timeline gains a pinned
	 *  event (filtered in usePinnedEvents - one room subscription for all
	 *  rows instead of an unfiltered listener per row). */
	timelineTick: () => number;
	/** Room-scoped cache of resolved projections (usePinnedEvents). */
	resolveCache: Map<string, ResolvedPinnedEvent>;
	/** Private timeline set for /context fetches - keeps pin loads out of
	 *  the room's own sets (no emissions into useTimeline's backfill
	 *  guard, no unfiltered-set growth). */
	contextTimelineSet: EventTimelineSet | null;
	canPin: boolean;
	shortcodeLookup: Map<string, ResolvedEmote>;
	tabIndex: number;
	rowRef?: (el: HTMLElement | null, prevEl?: HTMLElement) => void;
	/** `threadRootId` is set when the pinned event is a thread reply. The
	 *  row supplies it (rather than the panel) because a standalone-fetched
	 *  reply exists only in this row's resource, not in the SDK cache. */
	onJump: (threadRootId?: string) => void;
	onUnpin: () => void;
	onFocus?: () => void;
}> = (props) => {
	// Bumped when the resolved event finishes decrypting (see the watcher
	// below) so the projection re-derives from its now-clear content.
	const [decryptTick, setDecryptTick] = createSignal(0);

	// Re-evaluated when the panel's filtered timeline tick fires (a pinned
	// event arrived via back-pagination or live insert) or decryption
	// completes, so an already-open row resolves without a close/reopen
	// (#485). `sameResolved` keeps the returned identity stable when the
	// projection is unchanged - the keyed <Show> below must not remount
	// every row on every tick.
	const initial = createMemo<ResolvedPinnedEvent | null>(
		() => {
			props.timelineTick();
			decryptTick();
			return resolveSync(props.room, props.eventId);
		},
		null,
		{ equals: sameResolved },
	);

	// If the event isn't in the SDK's in-memory cache, load its /context
	// into the panel's PRIVATE timeline set - the event mapper runs
	// (decryption + relations) but nothing leaks into the room's own sets.
	// Cached per room in the panel hook so a close/reopen doesn't repeat
	// the round-trips.
	const [fetched] = createResource(
		() => (initial() ? null : props.eventId),
		async (id) => {
			if (!id) return null;
			const cached = props.resolveCache.get(id);
			if (cached) return cached;
			try {
				if (props.contextTimelineSet) {
					await props.client.getEventTimeline(props.contextTimelineSet, id);
				}
			} catch (e) {
				// Console-only: the row's "(message unavailable)" state is the
				// inline failure surface. Swallowing silently is what hid the
				// missing-timelineSupport misconfiguration behind every pin
				// rendering unavailable (#485) - and the standalone fallback
				// below must still get its chance.
				reportError(e, {
					logLabel: `pinned: getEventTimeline failed for ${id}`,
				});
			}
			const ev =
				props.contextTimelineSet?.findEventById(id) ??
				props.room.findEventById(id);
			let resolved: ResolvedPinnedEvent | null = null;
			if (ev) {
				// Events mapped into the private set aren't scheduled for
				// decryption by the room's machinery - nudge explicitly (a
				// no-op for unencrypted events).
				await props.client.decryptEventIfNeeded(ev);
				resolved = projectEvent(props.room, ev);
			} else {
				// A pinned THREAD reply never lands in a room timeline set
				// (the SDK's context path refuses thread events), so fetch it
				// standalone: enough to render the row and carry the thread
				// root for the jump, without materializing the whole thread
				// up front - the thread panel does that when the user jumps.
				// Also the last resort when getEventTimeline itself failed.
				resolved = await fetchStandalone(props.client, props.room, id);
			}
			if (resolved) props.resolveCache.set(id, resolved);
			return resolved;
		},
	);

	const resolved = createMemo<ResolvedPinnedEvent | null>(
		() => {
			// Track decryption for the FETCHED path too: re-project from the
			// (same) event object once its content is clear.
			decryptTick();
			const i = initial();
			if (i) return i;
			const f = fetched();
			if (!f) return null;
			return projectEvent(props.room, f.event);
		},
		null,
		{ equals: sameResolved },
	);

	// E2EE: a cached-but-undecrypted pin renders the non-text fallback and
	// RoomEvent.Timeline never re-fires for decryption completion - that
	// arrives as MatrixEventEvent.Decrypted on the event itself. Watch the
	// resolved event while it is pending and re-derive when keys land.
	createEffect(() => {
		// Track the tick directly: `resolved()` is equals-suppressed, so a
		// FAILED retry (projection unchanged) would never re-run this effect
		// through the memo alone - and re-arming below depends on it.
		decryptTick();
		const ev = resolved()?.event;
		if (!ev) return;
		// Watch while decryption is pending OR has FAILED: a failed attempt
		// sets clearEvent, which makes shouldAttemptDecryption() false, but
		// rust-crypto retries when the megolm key arrives and emits
		// Decrypted again - without the isDecryptionFailure() arm the row
		// would keep the undecryptable fallback until close/reopen.
		if (
			!ev.isBeingDecrypted() &&
			!ev.shouldAttemptDecryption() &&
			!ev.isDecryptionFailure()
		) {
			return;
		}
		void props.client.decryptEventIfNeeded(ev);
		const onDecrypted = (): void => {
			// Cached projections hold the encrypted-era fields; drop before
			// re-deriving. The tick re-runs this effect, which RE-ARMS the
			// watcher if this fire was itself a failed attempt (the guard
			// above stays true via isDecryptionFailure) and detaches for
			// good once the event is clear.
			props.resolveCache.delete(props.eventId);
			setDecryptTick((t) => t + 1);
		};
		ev.once(MatrixEventEvent.Decrypted, onDecrypted);
		onCleanup(() => ev.off(MatrixEventEvent.Decrypted, onDecrypted));
	});
	const isUnavailable = createMemo(
		() => !resolved() && !fetched.loading && initial() === null,
	);

	let myEl: HTMLElement | undefined;
	return (
		<article
			ref={(el) => {
				myEl = el;
				props.rowRef?.(el);
				// Solid does NOT call ref callbacks with null on unmount,
				// so register an explicit cleanup to drop the entry from
				// the panel's eventId -> element Map. Pass the element so
				// the panel can identity-check before deleting (avoids
				// clobbering a fresh remount that took the slot first).
				onCleanup(() => {
					if (myEl) props.rowRef?.(null, myEl);
				});
			}}
			class="group flex flex-col gap-1 rounded-md border border-transparent bg-surface-2/40 px-3 py-2 transition-colors hover:bg-surface-2 focus-within:bg-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
			tabIndex={props.tabIndex}
			aria-current={props.tabIndex === 0 ? "true" : undefined}
			onFocus={() => props.onFocus?.()}
			onKeyDown={(e) => {
				// Enter on the (roving-focused) row jumps, same as its "Jump
				// to" button - handled HERE because only the row can resolve
				// the thread root of a standalone-fetched reply. Unresolved
				// rows no-op: a jump with no known target would just yank the
				// main timeline (issue #334).
				if (e.key !== "Enter") return;
				const target = e.target as HTMLElement | null;
				if (target?.closest("button, a, input, textarea, select")) return;
				const r = resolved();
				if (!r) return;
				e.preventDefault();
				props.onJump(threadJumpTarget(r.event));
			}}
			aria-label={
				resolved()
					? `Pinned message from ${resolved()?.senderName}`
					: "Pinned message"
			}
		>
			<Show
				when={resolved()}
				keyed
				fallback={
					<Show
						when={isUnavailable()}
						fallback={
							<div class="flex flex-col gap-1">
								<div class="h-3 w-24 rounded bg-surface-3/60" />
								<div class="h-3 w-3/4 rounded bg-surface-3/60" />
								<div class="h-3 w-1/2 rounded bg-surface-3/60" />
							</div>
						}
					>
						<div class="text-xs text-text-muted">(message unavailable)</div>
						<Show when={props.canPin}>
							<div class="mt-1 flex justify-end">
								<button
									type="button"
									class="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={() => props.onUnpin()}
								>
									Unpin
								</button>
							</div>
						</Show>
					</Show>
				}
			>
				{(r) => (
					<>
						<div class="flex items-baseline gap-2">
							<span class="truncate text-xs font-semibold text-text-emphasis">
								{r.senderName}
							</span>
							<span class="shrink-0 text-[11px] text-text-disabled">
								{formatPinnedTime(r.timestamp)}
							</span>
						</div>
						<div class="line-clamp-3 text-xs text-text-secondary">
							<Show
								when={r.body || r.formattedBody}
								fallback={
									<span class="italic text-text-muted">
										({r.msgtype || "non-text"} message)
									</span>
								}
							>
								<MessageBody
									body={r.body}
									format={r.format}
									formattedBody={r.formattedBody}
									isEdited={false}
									client={props.client}
									shortcodeLookup={props.shortcodeLookup}
								/>
							</Show>
						</div>
						<div class="mt-1 flex items-center justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
							<button
								type="button"
								class="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								onClick={() => props.onJump(threadJumpTarget(r.event))}
							>
								Jump to
							</button>
							<Show when={props.canPin}>
								<button
									type="button"
									class="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={() => props.onUnpin()}
								>
									Unpin
								</button>
							</Show>
						</div>
					</>
				)}
			</Show>
		</article>
	);
};

export { PinnedMessageRow };
