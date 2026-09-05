import type { MatrixEvent } from "matrix-js-sdk";
import { EventStatus } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { useOptimisticActions } from "./useOptimisticActions";

interface EventOptions {
	id?: string | undefined;
	targetId?: unknown;
	key?: unknown;
	status?: EventStatus | null | undefined;
}

function event(options: EventOptions = {}): MatrixEvent {
	const content =
		options.targetId === undefined && options.key === undefined
			? {}
			: {
					"m.relates_to": {
						event_id: options.targetId,
						key: options.key,
					},
				};
	return {
		event: { redacts: options.targetId },
		getContent: () => content,
		getId: () => options.id,
		status: options.status,
	} as unknown as MatrixEvent;
}

function withActions(
	run: (actions: ReturnType<typeof useOptimisticActions>) => void,
) {
	createRoot((dispose) => {
		try {
			run(useOptimisticActions());
		} finally {
			dispose();
		}
	});
}

describe("useOptimisticActions", () => {
	it("records, replaces, and clears pending redactions by target", () =>
		withActions((actions) => {
			const sending = event({
				id: "~redaction-one",
				targetId: "$target",
				status: EventStatus.SENDING,
			});
			const failed = event({
				id: "~redaction-two",
				targetId: "$target",
				status: EventStatus.NOT_SENT,
			});

			actions.recordPendingRedaction(sending);
			expect(actions.pendingRedactions.$target).toEqual({
				redactionEvent: sending,
				status: EventStatus.SENDING,
			});

			actions.recordPendingRedaction(failed);
			expect(actions.pendingRedactions.$target).toEqual({
				redactionEvent: failed,
				status: EventStatus.NOT_SENT,
			});

			actions.clearPendingRedaction("$target");
			expect(actions.pendingRedactions.$target).toBeUndefined();
			actions.clearPendingRedaction("$missing");
		}));

	it("ignores malformed redaction events", () =>
		withActions((actions) => {
			actions.recordPendingRedaction(
				event({ id: "~missing-target", status: EventStatus.NOT_SENT }),
			);
			actions.recordPendingRedaction(
				event({
					id: "~invalid-target",
					targetId: 42,
					status: EventStatus.NOT_SENT,
				}),
			);
			actions.recordPendingRedaction(
				event({ id: "~missing-status", targetId: "$target" }),
			);

			expect(Object.keys(actions.pendingRedactions)).toEqual([]);
		}));

	it("stacks distinct reaction failures and deduplicates repeated event ids", () =>
		withActions((actions) => {
			const first = event({
				id: "~reaction-one",
				targetId: "$target",
				key: "reaction-key",
			});
			const duplicate = event({
				id: "~reaction-one",
				targetId: "$target",
				key: "reaction-key",
			});
			const second = event({
				id: "~reaction-two",
				targetId: "$target",
				key: "reaction-key",
			});
			const otherKey = event({
				id: "~reaction-three",
				targetId: "$target",
				key: "other-key",
			});
			const otherTarget = event({
				id: "~reaction-four",
				targetId: "$other",
				key: "reaction-key",
			});

			actions.upsertPendingReaction(first);
			actions.upsertPendingReaction(duplicate);
			actions.upsertPendingReaction(second);
			actions.upsertPendingReaction(otherKey);
			actions.upsertPendingReaction(otherTarget);

			expect(actions.pendingReactions.$target?.["reaction-key"]).toEqual([
				first,
				second,
			]);
			expect(actions.pendingReactions.$target?.["other-key"]).toEqual([
				otherKey,
			]);
			expect(actions.pendingReactions.$other?.["reaction-key"]).toEqual([
				otherTarget,
			]);
		}));

	it("removes the matching reaction and prunes empty key and target records", () =>
		withActions((actions) => {
			const first = event({
				id: "~reaction-one",
				targetId: "$target",
				key: "reaction-key",
			});
			const second = event({
				id: "~reaction-two",
				targetId: "$target",
				key: "reaction-key",
			});
			const otherKey = event({
				id: "~reaction-three",
				targetId: "$target",
				key: "other-key",
			});

			actions.upsertPendingReaction(first);
			actions.upsertPendingReaction(second);
			actions.upsertPendingReaction(otherKey);
			actions.removePendingReaction(
				event({
					id: "~missing",
					targetId: "$target",
					key: "reaction-key",
				}),
			);
			expect(actions.pendingReactions.$target?.["reaction-key"]).toHaveLength(
				2,
			);

			actions.removePendingReaction(first);
			expect(actions.pendingReactions.$target?.["reaction-key"]).toEqual([
				second,
			]);
			actions.removePendingReaction(second);
			expect(
				actions.pendingReactions.$target?.["reaction-key"],
			).toBeUndefined();
			expect(actions.pendingReactions.$target?.["other-key"]).toEqual([
				otherKey,
			]);

			actions.removePendingReaction(otherKey);
			expect(actions.pendingReactions.$target).toBeUndefined();
		}));

	it("ignores malformed reaction upserts and removals", () =>
		withActions((actions) => {
			const malformed = [
				event({ id: "~missing-target", key: "reaction-key" }),
				event({ id: "~invalid-target", targetId: 42, key: "reaction-key" }),
				event({ id: "~missing-key", targetId: "$target" }),
				event({ id: "~invalid-key", targetId: "$target", key: 42 }),
				event({ targetId: "$target", key: "reaction-key" }),
			];

			for (const item of malformed) {
				actions.upsertPendingReaction(item);
				actions.removePendingReaction(item);
			}
			expect(Object.keys(actions.pendingReactions)).toEqual([]);
		}));

	it("stacks, deduplicates, removes, and prunes pending edits", () =>
		withActions((actions) => {
			const first = event({ id: "~edit-one", targetId: "$target" });
			const duplicate = event({ id: "~edit-one", targetId: "$target" });
			const second = event({ id: "~edit-two", targetId: "$target" });

			actions.upsertPendingEdit(first);
			actions.upsertPendingEdit(duplicate);
			actions.upsertPendingEdit(second);
			expect(actions.pendingEdits.$target).toEqual([first, second]);

			actions.removePendingEdit(event({ id: "~missing", targetId: "$target" }));
			expect(actions.pendingEdits.$target).toHaveLength(2);
			actions.removePendingEdit(first);
			expect(actions.pendingEdits.$target).toEqual([second]);
			actions.removePendingEdit(second);
			expect(actions.pendingEdits.$target).toBeUndefined();
		}));

	it("ignores malformed edit upserts and removals", () =>
		withActions((actions) => {
			const malformed = [
				event({ id: "~missing-target" }),
				event({ id: "~invalid-target", targetId: 42 }),
				event({ targetId: "$target" }),
			];

			for (const item of malformed) {
				actions.upsertPendingEdit(item);
				actions.removePendingEdit(item);
			}
			expect(Object.keys(actions.pendingEdits)).toEqual([]);
		}));

	it("resets all optimistic state synchronously", () =>
		withActions((actions) => {
			actions.recordPendingRedaction(
				event({
					id: "~redaction",
					targetId: "$target",
					status: EventStatus.NOT_SENT,
				}),
			);
			actions.upsertPendingReaction(
				event({
					id: "~reaction",
					targetId: "$target",
					key: "reaction-key",
				}),
			);
			actions.upsertPendingEdit(event({ id: "~edit", targetId: "$target" }));

			actions.resetOptimistic();

			expect(Object.keys(actions.pendingRedactions)).toEqual([]);
			expect(Object.keys(actions.pendingReactions)).toEqual([]);
			expect(Object.keys(actions.pendingEdits)).toEqual([]);
		}));
});
