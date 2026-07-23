import { type MatrixClient, MatrixEvent, type Room } from "matrix-js-sdk";
import {
	type Component,
	createMemo,
	createResource,
	onCleanup,
	Show,
} from "solid-js";
import { threadJumpTarget } from "../../../lib/threadEvents";
import { MessageBody } from "../../emoji/MessageBody";
import type { ResolvedEmote } from "../../emoji/types";

interface ResolvedPinnedEvent {
	event: MatrixEvent;
	sender: string;
	senderName: string;
	timestamp: number;
	body: string;
	format: string | null;
	formattedBody: string | null;
	msgtype: string;
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
		senderName: member?.name ?? sender,
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
	const initial = createMemo<ResolvedPinnedEvent | null>(() =>
		resolveSync(props.room, props.eventId),
	);

	// If the event isn't in the SDK's in-memory cache, ask the SDK to
	// load it through getEventTimeline — that fetches /context, runs the
	// event mapper (decryption + relations), and on success
	// room.findEventById(id) returns the fully-decrypted event.
	const [fetched] = createResource(
		() => (initial() ? null : props.eventId),
		async (id) => {
			if (!id) return null;
			try {
				await props.client.getEventTimeline(
					props.room.getUnfilteredTimelineSet(),
					id,
				);
				const resolved = resolveSync(props.room, id);
				if (resolved) return resolved;
				// A pinned THREAD reply never lands in a room timeline set
				// (the SDK's context path refuses thread events), so fetch it
				// standalone: enough to render the row and carry the thread
				// root for the jump, without materializing the whole thread
				// up front — the thread panel does that when the user jumps.
				return await fetchStandalone(props.client, props.room, id);
			} catch {
				return null;
			}
		},
	);

	const resolved = createMemo<ResolvedPinnedEvent | null>(
		() => initial() ?? fetched() ?? null,
	);
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
			class="group flex flex-col gap-1 rounded-md border border-transparent bg-surface-2/40 px-3 py-2 transition-colors hover:bg-surface-2 focus-within:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
			tabIndex={props.tabIndex}
			aria-current={props.tabIndex === 0 ? "true" : undefined}
			onFocus={() => props.onFocus?.()}
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
									class="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
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
								class="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								onClick={() => props.onJump(threadJumpTarget(r.event))}
							>
								Jump to
							</button>
							<Show when={props.canPin}>
								<button
									type="button"
									class="rounded px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
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
