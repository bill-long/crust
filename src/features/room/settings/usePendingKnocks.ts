import {
	type MatrixClient,
	type MatrixEvent,
	type RoomMember,
	type RoomState,
	RoomStateEvent,
} from "matrix-js-sdk";
import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { avatarHttpUrl } from "../../../lib/avatar";
import { displayNameOr } from "../../../lib/displayName";

export interface PendingKnock {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
	knockedAt: number | null;
	/** The optional reason the knocker supplied, if any. */
	reason: string | null;
}

function buildKnock(member: RoomMember, client: MatrixClient): PendingKnock {
	const event = (member as RoomMember & { events?: { member?: MatrixEvent } })
		.events?.member;
	const reason = event?.getContent()?.reason;
	return {
		userId: member.userId,
		displayName: displayNameOr(member.name, member.userId),
		avatarUrl: avatarHttpUrl(client, member.getMxcAvatarUrl(), 32),
		knockedAt: event?.getTs() ?? null,
		reason:
			typeof reason === "string" && reason.trim()
				? // The reason is wire-controlled and lands in a signal + DOM text
					// node - cap it (CSS truncate bounds display, not data).
					reason.trim().slice(0, 500)
				: null,
	};
}

/**
 * Reactive list of room members whose membership is `knock` (pending join
 * requests a moderator can approve or decline). Mirrors
 * {@link usePendingInvites}: subscribes to `RoomStateEvent.Members` on the
 * MatrixClient (per stored convention - listen on client, not room) and
 * re-derives on every membership change.
 */
export function usePendingKnocks(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): Accessor<PendingKnock[]> {
	const [knocks, setKnocks] = createSignal<PendingKnock[]>([]);

	const refresh = (): void => {
		const rid = roomId();
		if (!rid) {
			setKnocks([]);
			return;
		}
		const room = client.getRoom(rid);
		if (!room) {
			setKnocks([]);
			return;
		}
		const pending = room
			.getMembers()
			.filter((m) => m.membership === "knock")
			.map((m) => buildKnock(m, client))
			.sort((a, b) => a.displayName.localeCompare(b.displayName));
		setKnocks(pending);
	};

	let pendingFrame: number | null = null;
	const scheduleRefresh = (): void => {
		if (pendingFrame !== null) return;
		pendingFrame = requestAnimationFrame(() => {
			pendingFrame = null;
			refresh();
		});
	};

	refresh();

	// Re-refresh on roomId changes. `on(..., { defer: true })` skips the
	// initial run since the eager refresh() above already populated for
	// the current roomId.
	createEffect(
		on(
			roomId,
			() => {
				refresh();
			},
			{ defer: true },
		),
	);

	const onMembers = (
		_event: MatrixEvent,
		_state: RoomState,
		member: RoomMember,
	): void => {
		if (member.roomId === roomId()) scheduleRefresh();
	};

	client.on(RoomStateEvent.Members, onMembers);

	onCleanup(() => {
		client.off(RoomStateEvent.Members, onMembers);
		if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
	});

	return knocks;
}
