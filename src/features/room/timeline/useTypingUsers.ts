import type { MatrixClient, MatrixEvent, RoomMember } from "matrix-js-sdk";
import { RoomMemberEvent } from "matrix-js-sdk";
import { type Accessor, createSignal, onCleanup } from "solid-js";

export interface TypingUser {
	userId: string;
	displayName: string;
}

/**
 * Tracks who is currently typing in the active room. Listens to
 * RoomMemberEvent.Typing and recomputes the list (excluding the local user)
 * from the room's members whenever a typing notification arrives for the
 * active room.
 *
 * `activeRoomId` is read live on each event so the filter always reflects the
 * room the timeline is currently windowing (the caller owns that value and
 * updates it on room switch). `resetTyping` lets the caller clear the list
 * synchronously at its room-switch reset point, so a stale indicator from the
 * previous room never flashes in the new one.
 *
 * The listener is registered under the caller's reactive owner and removed on
 * cleanup.
 */
export function useTypingUsers(
	client: MatrixClient,
	activeRoomId: Accessor<string | null>,
): { typingUsers: Accessor<TypingUser[]>; resetTyping: () => void } {
	const [typingUsers, setTypingUsers] = createSignal<TypingUser[]>([]);

	function onTyping(_event: MatrixEvent, member: RoomMember): void {
		const rid = activeRoomId();
		if (!rid || member.roomId !== rid) return;
		const room = client.getRoom(rid);
		if (!room) return;
		const myUserId = client.getUserId();
		const typing: TypingUser[] = [];
		for (const m of room.getMembers()) {
			if (m.typing && m.userId !== myUserId) {
				typing.push({
					userId: m.userId,
					displayName: m.name?.trim() || m.userId,
				});
			}
		}
		setTypingUsers(typing);
	}

	client.on(RoomMemberEvent.Typing, onTyping);
	onCleanup(() => {
		client.off(RoomMemberEvent.Typing, onTyping);
	});

	return {
		typingUsers,
		resetTyping: () => setTypingUsers([]),
	};
}
