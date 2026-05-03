import {
	type MatrixClient,
	type MatrixEvent,
	type RoomMember,
	RoomMemberEvent,
	type RoomState,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createEffect, createSignal, onCleanup } from "solid-js";

export interface MemberEntry {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
	powerLevel: number;
	isTyping: boolean;
}

export type RoleLabel = "Admin" | "Moderator" | "Member";

export interface MemberGroup {
	role: RoleLabel;
	members: MemberEntry[];
}

function roleForPowerLevel(powerLevel: number): RoleLabel {
	if (powerLevel >= 100) return "Admin";
	if (powerLevel >= 50) return "Moderator";
	return "Member";
}

function buildEntry(member: RoomMember, client: MatrixClient): MemberEntry {
	const mxcUrl = member.getMxcAvatarUrl();
	return {
		userId: member.userId,
		displayName: member.name?.trim() || member.userId,
		avatarUrl: mxcUrl
			? (client.mxcUrlToHttp(mxcUrl, 32, 32, "crop") ?? null)
			: null,
		powerLevel: member.powerLevel ?? 0,
		isTyping: member.typing ?? false,
	};
}

function groupMembers(entries: MemberEntry[]): MemberGroup[] {
	const admins: MemberEntry[] = [];
	const moderators: MemberEntry[] = [];
	const members: MemberEntry[] = [];

	for (const entry of entries) {
		const role = roleForPowerLevel(entry.powerLevel);
		if (role === "Admin") admins.push(entry);
		else if (role === "Moderator") moderators.push(entry);
		else members.push(entry);
	}

	const cmp = (a: MemberEntry, b: MemberEntry): number =>
		a.displayName.localeCompare(b.displayName);
	admins.sort(cmp);
	moderators.sort(cmp);
	members.sort(cmp);

	const groups: MemberGroup[] = [];
	if (admins.length > 0) groups.push({ role: "Admin", members: admins });
	if (moderators.length > 0)
		groups.push({ role: "Moderator", members: moderators });
	if (members.length > 0) groups.push({ role: "Member", members: members });
	return groups;
}

/**
 * Reactive hook that provides the joined member list for a room,
 * grouped by role (Admin / Moderator / Member).
 */
export function useMemberList(
	client: MatrixClient,
	roomId: () => string,
): {
	groups: () => MemberGroup[];
	memberCount: () => number;
	loading: () => boolean;
} {
	const [groups, setGroups] = createSignal<MemberGroup[]>([]);
	const [memberCount, setMemberCount] = createSignal(0);
	const [loading, setLoading] = createSignal(true);

	function refresh(rid: string): void {
		const room = client.getRoom(rid);
		if (!room) {
			setGroups([]);
			setMemberCount(0);
			setLoading(false);
			return;
		}

		const joined = room.getJoinedMembers();
		const entries = joined.map((m) => buildEntry(m, client));
		setGroups(groupMembers(entries));
		setMemberCount(entries.length);
		setLoading(false);
	}

	// Coalesce rapid events (e.g. multiple typing notifications) into
	// at most one refresh per animation frame.
	let pendingFrame: number | null = null;
	function scheduleRefresh(): void {
		if (pendingFrame !== null) return;
		pendingFrame = requestAnimationFrame(() => {
			pendingFrame = null;
			refresh(roomId());
		});
	}

	// Reload on room change
	createEffect(() => {
		const rid = roomId();
		setLoading(true);
		refresh(rid);
	});

	// Refresh on membership / name / power-level changes
	const onMemberStateChange = (
		_event: MatrixEvent,
		_state: RoomState,
		member: RoomMember,
	): void => {
		if (member.roomId === roomId()) {
			scheduleRefresh();
		}
	};

	// Refresh on typing changes
	const onTyping = (_event: MatrixEvent, member: RoomMember): void => {
		if (member.roomId === roomId()) {
			scheduleRefresh();
		}
	};

	client.on(RoomStateEvent.Members, onMemberStateChange);
	client.on(RoomMemberEvent.Typing, onTyping);

	onCleanup(() => {
		client.off(RoomStateEvent.Members, onMemberStateChange);
		client.off(RoomMemberEvent.Typing, onTyping);
		if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
	});

	return { groups, memberCount, loading };
}

// Exported for testing
export { buildEntry, groupMembers, roleForPowerLevel };
