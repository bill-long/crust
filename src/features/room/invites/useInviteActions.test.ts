import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { describe, expect, it, vi } from "vitest";
import type { RoomSummary, SummariesStore } from "../../../client/summaries";

// Mock useClient before importing the hook
vi.mock("../../../client/client", () => ({
	useClient: vi.fn(),
}));

import { useClient } from "../../../client/client";
import { useInviteActions } from "./useInviteActions";

const ROOM_ID = "!invited:example.com";
const MY_ID = "@me:example.com";
const INVITER_ID = "@amon:example.com";

function makeSummary(partial: Partial<RoomSummary> = {}): RoomSummary {
	return {
		roomId: ROOM_ID,
		name: "events",
		avatarUrl: "https://example.com/avatar",
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
		isFavourite: false,
		isLowPriority: false,
		membership: "invite",
		isEncrypted: false,
		isDirect: false,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...partial,
	};
}

function setup(opts: {
	summary?: RoomSummary;
	inviteContent?: Record<string, unknown>;
	joinRoom?: ReturnType<typeof vi.fn>;
	leave?: ReturnType<typeof vi.fn>;
}) {
	const [summaries] = createStore<SummariesStore>(
		opts.summary ? { [ROOM_ID]: opts.summary } : {},
	);
	const room = {
		name: "events",
		getMember: (userId: string) => {
			if (userId === MY_ID) {
				return {
					events: {
						member: {
							getSender: () => INVITER_ID,
							getContent: () => opts.inviteContent ?? { membership: "invite" },
						},
					},
				};
			}
			if (userId === INVITER_ID) return { name: "Amon", events: {} };
			return null;
		},
	};
	const client = {
		getUserId: () => MY_ID,
		getRoom: (rid: string) => (rid === ROOM_ID ? room : null),
		joinRoom: opts.joinRoom ?? vi.fn().mockResolvedValue({}),
		leave: opts.leave ?? vi.fn().mockResolvedValue({}),
		// recordDmInDirectMap reads + writes m.direct through these.
		getAccountData: () => undefined,
		setAccountData: vi.fn().mockResolvedValue({}),
	};
	const optimisticallyMarkJoined = vi.fn();
	const optimisticallyMarkLeft = vi.fn();
	(useClient as ReturnType<typeof vi.fn>).mockReturnValue({
		client,
		summaries,
		optimisticallyMarkJoined,
		optimisticallyMarkKnocked: vi.fn(),
		optimisticallyMarkLeft,
	});
	return { client, optimisticallyMarkJoined, optimisticallyMarkLeft };
}

function withRoot<T>(fn: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		createRoot(async (dispose) => {
			try {
				resolve(await fn());
			} catch (e) {
				reject(e);
			} finally {
				dispose();
			}
		});
	});
}

describe("useInviteActions", () => {
	it("accept joins the room and optimistically marks it joined from the summary", () =>
		withRoot(async () => {
			const { client, optimisticallyMarkJoined } = setup({
				summary: makeSummary(),
			});
			const actions = useInviteActions(() => ROOM_ID);
			await actions.accept();
			expect(client.joinRoom).toHaveBeenCalledWith(ROOM_ID);
			expect(optimisticallyMarkJoined).toHaveBeenCalledWith(ROOM_ID, {
				name: "events",
				avatarUrl: "https://example.com/avatar",
				isSpace: false,
				isDirect: false,
			});
			// Not a DM invite: m.direct must not be written.
			expect(client.setAccountData).not.toHaveBeenCalled();
			expect(actions.error()).toBeNull();
			expect(actions.pending()).toBeNull();
		}));

	it("accept records a DM invite in m.direct under the inviter", () =>
		withRoot(async () => {
			const { client, optimisticallyMarkJoined } = setup({
				summary: makeSummary(),
				inviteContent: { membership: "invite", is_direct: true },
			});
			const actions = useInviteActions(() => ROOM_ID);
			await actions.accept();
			expect(client.setAccountData).toHaveBeenCalledWith("m.direct", {
				[INVITER_ID]: [ROOM_ID],
			});
			expect(optimisticallyMarkJoined).toHaveBeenCalledWith(
				ROOM_ID,
				expect.objectContaining({ isDirect: true }),
			);
		}));

	it("accept surfaces a join failure inline and does not mark joined", () =>
		withRoot(async () => {
			const { optimisticallyMarkJoined } = setup({
				summary: makeSummary(),
				joinRoom: vi.fn().mockRejectedValue(new Error("M_FORBIDDEN")),
			});
			const actions = useInviteActions(() => ROOM_ID);
			await actions.accept();
			expect(actions.error()).toBe("M_FORBIDDEN");
			expect(actions.pending()).toBeNull();
			expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		}));

	it("accept still succeeds when the m.direct write fails", () =>
		withRoot(async () => {
			const { client, optimisticallyMarkJoined } = setup({
				summary: makeSummary(),
				inviteContent: { membership: "invite", is_direct: true },
			});
			client.setAccountData.mockRejectedValue(new Error("network"));
			const actions = useInviteActions(() => ROOM_ID);
			await actions.accept();
			expect(optimisticallyMarkJoined).toHaveBeenCalled();
			expect(actions.error()).toBeNull();
		}));

	it("decline leaves the room, marks it left, and calls onDeclined", () =>
		withRoot(async () => {
			const onDeclined = vi.fn();
			const { client, optimisticallyMarkLeft } = setup({
				summary: makeSummary(),
			});
			const actions = useInviteActions(() => ROOM_ID, { onDeclined });
			await actions.decline();
			expect(client.leave).toHaveBeenCalledWith(ROOM_ID);
			expect(optimisticallyMarkLeft).toHaveBeenCalledWith(ROOM_ID);
			expect(onDeclined).toHaveBeenCalled();
		}));

	it("decline surfaces a failure inline and does not navigate away", () =>
		withRoot(async () => {
			const onDeclined = vi.fn();
			const { optimisticallyMarkLeft } = setup({
				summary: makeSummary(),
				leave: vi.fn().mockRejectedValue(new Error("M_LIMIT_EXCEEDED")),
			});
			const actions = useInviteActions(() => ROOM_ID, { onDeclined });
			await actions.decline();
			expect(actions.error()).toBe("M_LIMIT_EXCEEDED");
			expect(optimisticallyMarkLeft).not.toHaveBeenCalled();
			expect(onDeclined).not.toHaveBeenCalled();
		}));

	it("ignores a second action while one is in flight", () =>
		withRoot(async () => {
			let resolveJoin: (v: unknown) => void = () => {};
			const joinRoom = vi.fn().mockImplementation(
				() =>
					new Promise((r) => {
						resolveJoin = r;
					}),
			);
			const { client } = setup({ summary: makeSummary(), joinRoom });
			const actions = useInviteActions(() => ROOM_ID);
			const first = actions.accept();
			expect(actions.pending()).toBe("accept");
			await actions.accept();
			await actions.decline();
			expect(client.joinRoom).toHaveBeenCalledTimes(1);
			expect(client.leave).not.toHaveBeenCalled();
			resolveJoin({});
			await first;
			expect(actions.pending()).toBeNull();
		}));
});
