import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { EventStatus } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNotices, notices } from "../../../stores/notices";
import type { TimelineEvent } from "./timelineTypes";
import { useMessageActions } from "./useMessageActions";

afterEach(() => {
	clearNotices();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function makeDeps(events: TimelineEvent[]) {
	return {
		events,
		getSourceEvent: () => undefined,
		pendingRedactions: {},
		pendingReactions: {},
		pendingEdits: {},
		setReplyTo: () => {},
		setEditingEvent: () => {},
	};
}

const roomId = () => "!room:server";
const noThread = () => undefined;

function failedEvent(id: string): MatrixEvent {
	return { getId: () => id, status: EventStatus.NOT_SENT } as MatrixEvent;
}

describe("useMessageActions reaction error surfacing", () => {
	it("toasts when removing your own reaction fails (no inline affordance for a failed reaction redaction)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = {
			redactEvent: vi.fn().mockRejectedValue(new Error("M_FORBIDDEN")),
			sendEvent: vi.fn(),
			getRoom: vi.fn(),
		} as unknown as MatrixClient;
		// myReactions[key] present -> this is an un-react (redaction) click.
		const events = [
			{ eventId: "$m1", myReactions: { "\u{1F44D}": "$react1" } },
		] as unknown as TimelineEvent[];

		const actions = useMessageActions(
			client,
			roomId,
			noThread,
			makeDeps(events),
		);
		await actions.onReact("$m1", "\u{1F44D}");

		expect(client.redactEvent).toHaveBeenCalledWith(
			"!room:server",
			null,
			"$react1",
		);
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toMatchObject({ tone: "error" });
	});

	it("does NOT toast when adding a reaction fails (FailedReactionPills already surfaces it)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = {
			sendEvent: vi.fn().mockRejectedValue(new Error("M_FORBIDDEN")),
			redactEvent: vi.fn(),
			getRoom: vi.fn(),
		} as unknown as MatrixClient;
		// myReactions empty -> this is a new reaction (send) click.
		const events = [
			{ eventId: "$m1", myReactions: {} },
		] as unknown as TimelineEvent[];

		const actions = useMessageActions(
			client,
			roomId,
			noThread,
			makeDeps(events),
		);
		await actions.onReact("$m1", "\u{1F44D}");

		expect(client.sendEvent).toHaveBeenCalled();
		expect(notices()).toHaveLength(0);
	});

	it("threads a redaction reason through onDelete (and omits opts without one)", async () => {
		const client = {
			redactEvent: vi.fn().mockResolvedValue({ event_id: "$r1" }),
			sendEvent: vi.fn(),
			getRoom: vi.fn(),
		} as unknown as MatrixClient;
		const actions = useMessageActions(client, roomId, noThread, makeDeps([]));

		await actions.onDelete("$m1", "  spam  ");
		expect(client.redactEvent).toHaveBeenLastCalledWith(
			"!room:server",
			null,
			"$m1",
			undefined,
			{ reason: "spam" },
		);

		// Blank / whitespace-only reasons must not put an empty reason on
		// the wire.
		await actions.onDelete("$m2", "   ");
		expect(client.redactEvent).toHaveBeenLastCalledWith(
			"!room:server",
			null,
			"$m2",
			undefined,
			undefined,
		);
		await actions.onDelete("$m3");
		expect(client.redactEvent).toHaveBeenLastCalledWith(
			"!room:server",
			null,
			"$m3",
			undefined,
			undefined,
		);
	});

	it("does not toast when removing a reaction succeeds", async () => {
		const client = {
			redactEvent: vi.fn().mockResolvedValue({ event_id: "$r1" }),
			sendEvent: vi.fn(),
			getRoom: vi.fn(),
		} as unknown as MatrixClient;
		const events = [
			{ eventId: "$m1", myReactions: { "\u{1F44D}": "$react1" } },
		] as unknown as TimelineEvent[];

		const actions = useMessageActions(
			client,
			roomId,
			noThread,
			makeDeps(events),
		);
		await actions.onReact("$m1", "\u{1F44D}");

		expect(notices()).toHaveLength(0);
	});
});

describe("useMessageActions failed-echo retries", () => {
	it("retries the newest reaction and edit echoes", async () => {
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn(() => 1),
		);
		const resendEvent = vi.fn().mockResolvedValue(undefined);
		const client = {
			getRoom: vi.fn(() => ({})),
			resendEvent,
		} as unknown as MatrixClient;
		const reaction = failedEvent("$reaction-new");
		const edit = failedEvent("$edit-new");
		const actions = useMessageActions(client, roomId, noThread, {
			...makeDeps([]),
			pendingReactions: {
				$target: { sparkle: [failedEvent("$reaction-old"), reaction] },
			},
			pendingEdits: { $target: [failedEvent("$edit-old"), edit] },
		});

		await actions.onRetryReaction("$target", "sparkle");
		await actions.onRetryEdit("$target");

		expect(resendEvent).toHaveBeenNthCalledWith(1, reaction, {});
		expect(resendEvent).toHaveBeenNthCalledWith(2, edit, {});
	});

	it("ignores an absent newest reaction or edit slot", async () => {
		const resendEvent = vi.fn();
		const client = {
			getRoom: vi.fn(() => ({})),
			resendEvent,
		} as unknown as MatrixClient;
		const reactions = [failedEvent("$reaction")];
		reactions.length = 2;
		const edits = [failedEvent("$edit")];
		edits.length = 2;
		const actions = useMessageActions(client, roomId, noThread, {
			...makeDeps([]),
			pendingReactions: { $target: { sparkle: reactions } },
			pendingEdits: { $target: edits },
		});

		await actions.onRetryReaction("$target", "sparkle");
		await actions.onRetryEdit("$target");

		expect(resendEvent).not.toHaveBeenCalled();
	});
});
