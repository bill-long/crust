import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNotices, notices } from "../../../stores/notices";
import type { TimelineEvent } from "./timelineTypes";
import { useMessageActions } from "./useMessageActions";

afterEach(() => {
	clearNotices();
	vi.restoreAllMocks();
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
