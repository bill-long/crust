import type { RoomSummary } from "../client/summaries";

/**
 * Canonical RoomSummary defaults for tests. Prefer this over inlining the
 * full literal: adding a RoomSummary field then costs one line here
 * instead of a mechanical sweep across every test file's private copy
 * (as the spaceOrder and tag fields required). Existing per-file
 * factories are being migrated opportunistically.
 */
export function makeSummary(
	roomId: string,
	overrides: Partial<RoomSummary> = {},
): RoomSummary {
	return {
		roomId,
		name: roomId,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
		isFavourite: false,
		isLowPriority: false,
		spaceOrder: null,
		isMuted: false,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		dmUserId: null,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...overrides,
	};
}
