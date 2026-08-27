import {
	type MatrixClient,
	type MatrixEvent,
	type RoomMember,
	RoomMemberEvent,
	type RoomState,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { PresenceInfo, PresenceStatus } from "../../client/presence";
import { avatarHttpUrl } from "../../lib/avatar";
import { displayNameOr } from "../../lib/controlChars";

export interface MemberEntry {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
	powerLevel: number;
	isTyping: boolean;
}

/** One ordering for every member section, so they cannot drift apart. */
const cmp = (a: MemberEntry, b: MemberEntry): number =>
	a.displayName.localeCompare(b.displayName);

export type RoleLabel = "Admin" | "Moderator" | "Member";

/**
 * A section heading in the member list. Roles, plus the one presence-derived
 * section: Discord keeps offline people together at the bottom rather than
 * scattered through the roles, because the useful question in a busy room is
 * "who is around", not "who holds power and is also asleep".
 */
export type GroupLabel = RoleLabel | "Offline";

export interface MemberGroup {
	role: GroupLabel;
	members: MemberEntry[];
}

function roleForPowerLevel(powerLevel: number): RoleLabel {
	if (powerLevel >= 100) return "Admin";
	if (powerLevel >= 50) return "Moderator";
	return "Member";
}

function buildEntry(member: RoomMember, client: MatrixClient): MemberEntry {
	return {
		userId: member.userId,
		// Rejected rather than cleaned. This reaches a one-line row and,
		// through `memberRowLabel`, an aria-label - and a name the SDK could
		// not disambiguate because of a control character would, if merely
		// stripped, render as an exact copy of someone else's. Falling back
		// to the user ID is what the timeline already does.
		displayName: displayNameOr(member.name, member.userId),
		avatarUrl: avatarHttpUrl(client, member.getMxcAvatarUrl(), 32),
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

const PRESENCE_WORD: Partial<Record<PresenceStatus, string>> = {
	online: "online",
	idle: "idle",
	offline: "offline",
};

/**
 * Accessible name for a member row: who, how present, and what they are
 * doing.
 *
 * Takes the presence reading as an argument rather than reaching for the
 * store, matching {@link partitionByPresence} - it keeps this a pure
 * function the view can drive and a test can exercise without a client.
 */
export function memberRowLabel(
	member: MemberEntry,
	presence: PresenceInfo,
): string {
	const word = PRESENCE_WORD[presence.status];
	const parts = [`View profile of ${member.displayName}`];
	if (word) parts.push(word);
	// Typing displaces the status message here exactly as it does on the
	// second line of the row. Announcing the status while the row shows
	// "typing" would make the two surfaces disagree in the one case where
	// they differ - and typing is the more immediate signal either way.
	if (member.isTyping) parts.push("typing");
	else if (presence.statusMsg) parts.push(presence.statusMsg);
	return parts.join(", ");
}

/**
 * Move offline members out of their role sections and into one Offline
 * section at the end.
 *
 * Takes the status lookup as an argument rather than reading the presence
 * store directly, so the rule stays a pure function the caller can drive from
 * a memo - and so it can be tested without a client.
 *
 * `unknown` counts as present, not offline. It means the server has never
 * mentioned that user, which in a large room is most of them; demoting them
 * would empty the role sections on the strength of something we were never
 * told. Only an explicit `offline` moves someone down.
 */
export function partitionByPresence(
	groups: readonly MemberGroup[],
	statusOf: (userId: string) => PresenceStatus,
): MemberGroup[] {
	const out: MemberGroup[] = [];
	const offlineRuns: MemberEntry[][] = [];

	for (const group of groups) {
		const present: MemberEntry[] = [];
		const offline: MemberEntry[] = [];
		for (const member of group.members) {
			if (statusOf(member.userId) === "offline") offline.push(member);
			else present.push(member);
		}
		if (present.length > 0) out.push({ role: group.role, members: present });
		if (offline.length > 0) offlineRuns.push(offline);
	}

	// Ordered with the same comparator the role sections use: this section is
	// filled role-by-role, so without it the list reads admins-then-members -
	// an order whose reason is no longer on screen.
	//
	// Merged rather than sorted. Each role group arrives sorted, so filtering
	// one preserves that and the runs only need interleaving. This memo now
	// re-runs on every presence batch, and in a large public room nearly the
	// whole list is offline - so a fresh sort would be an O(n log n)
	// localeCompare on the main thread per sync, which for a few thousand
	// members is far past the 16 ms budget. The merge is O(n * roles) with
	// roles fixed at three.
	const offline = mergeSorted(offlineRuns);
	if (offline.length > 0) out.push({ role: "Offline", members: offline });
	return out;
}

/**
 * Merge already-sorted runs into one sorted array, using {@link cmp}.
 *
 * A linear scan for the smallest head rather than a heap: the run count is
 * the number of roles, which is three, and at that size the scan is both
 * faster and easier to read than the heap that would beat it asymptotically.
 */
function mergeSorted(runs: MemberEntry[][]): MemberEntry[] {
	if (runs.length === 0) return [];
	if (runs.length === 1) return runs[0];

	let total = 0;
	for (const run of runs) total += run.length;

	const heads = new Array<number>(runs.length).fill(0);
	const out: MemberEntry[] = [];
	for (let taken = 0; taken < total; taken++) {
		let best = -1;
		for (let i = 0; i < runs.length; i++) {
			if (heads[i] >= runs[i].length) continue;
			if (best === -1 || cmp(runs[i][heads[i]], runs[best][heads[best]]) < 0) {
				best = i;
			}
		}
		out.push(runs[best][heads[best]]);
		heads[best]++;
	}
	return out;
}
