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

export interface PendingInvite {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
	invitedAt: number | null;
	invitedBy: string | null;
}

function buildInvite(member: RoomMember, client: MatrixClient): PendingInvite {
	const event = (member as RoomMember & { events?: { member?: MatrixEvent } })
		.events?.member;
	return {
		userId: member.userId,
		displayName: displayNameOr(member.name, member.userId),
		avatarUrl: avatarHttpUrl(client, member.getMxcAvatarUrl(), 32),
		invitedAt: event?.getTs() ?? null,
		invitedBy: event?.getSender() ?? null,
	};
}

/**
 * Reactive list of room members whose membership is `invite`
 * (pending invites). Subscribes to `RoomStateEvent.Members` on the
 * MatrixClient (per stored convention — listen on client, not room)
 * and re-derives on every membership change.
 */
export function usePendingInvites(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): Accessor<PendingInvite[]> {
	const [invites, setInvites] = createSignal<PendingInvite[]>([]);

	let pendingFrame: number | null = null;
	const scheduleRefresh = (): void => {
		if (pendingFrame !== null) return;
		pendingFrame = requestAnimationFrame(() => {
			pendingFrame = null;
			refresh();
		});
	};

	const refresh = (): void => {
		const rid = roomId();
		if (!rid) {
			setInvites([]);
			return;
		}
		const room = client.getRoom(rid);
		if (!room) {
			setInvites([]);
			return;
		}
		const pending = room
			.getMembers()
			.filter((m) => m.membership === "invite")
			.map((m) => buildInvite(m, client))
			.sort((a, b) => a.displayName.localeCompare(b.displayName));
		setInvites(pending);
	};

	refresh();

	// Re-refresh on roomId changes (e.g. overlay re-targets a different
	// room before the new room delivers a Members event). `on(..., { defer: true })`
	// skips the initial run since the eager refresh() above already
	// populated for the current roomId.
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

	return invites;
}
