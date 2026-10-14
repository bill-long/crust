import { describe, expect, it, vi } from "vitest";
import {
	canPublishMembership,
	livekitTransport,
	membershipTransport,
	publishedTransport,
} from "./rtcProtocol";

describe("RTC transport and permission boundaries", () => {
	it("normalizes an alias-less URL-only transport without advertising a legacy service", () => {
		const t = livekitTransport(
			{ type: "livekit", url: "wss://sfu.example.org" },
			"!room:example.org",
		);
		expect(t?.livekit_alias).toBe("!room:example.org");
		if (!t) throw new Error("Missing transport");
		expect(publishedTransport(t)).toEqual({
			type: "livekit",
			url: "wss://sfu.example.org",
		});
	});
	it.each([
		{ type: "livekit", url: "/relative" },
		{ type: "livekit", url: "https://sfu" },
		{ type: "livekit", livekit_service_url: "javascript:alert(1)" },
	])("rejects invalid transport destinations (%s)", (value) => {
		expect(livekitTransport(value, "!room:example.org")).toBeNull();
	});
	it("resolves an oldest-membership peer to the elected transport, not its unused offer", () => {
		const selected = {
			type: "livekit",
			livekit_service_url: "https://selected",
		};
		const peer = {
			eventId: "$peer",
			createdTs: () => 3,
			getTransport: () => ({
				type: "livekit",
				livekit_service_url: "https://unused",
			}),
		};
		const oldest = {
			eventId: "$legacy",
			createdTs: () => 2,
			getTransport: () => selected,
		};
		const sticky = {
			eventId: "$sticky",
			createdTs: () => 1,
			getTransport: () => ({ type: "livekit", url: "wss://wrong" }),
		};
		const client = {
			getRoom: () => ({
				currentState: {
					getStateEvents: () => [
						{ getId: () => "$legacy", getContent: () => ({}) },
						{
							getId: () => "$peer",
							getContent: () => ({
								focus_active: { focus_selection: "oldest_membership" },
							}),
						},
					],
				},
			}),
		};
		expect(
			membershipTransport(
				client as never,
				"!room:example.org",
				peer as never,
				[sticky, peer, oldest] as never,
			)?.livekit_service_url,
		).toBe("https://selected");
	});
	it("uses timeline permissions for sticky memberships and state permissions for legacy, always requiring room membership", () => {
		let membership = "join";
		const maySendEvent = vi.fn(() => true);
		const maySendStateEvent = vi.fn(() => false);
		const client = {
			getUserId: () => "@alice:example.org",
			getRoom: () => ({
				getMyMembership: () => membership,
				currentState: { maySendEvent, maySendStateEvent },
			}),
		};
		expect(canPublishMembership(client as never, "!room", true)).toBe(true);
		expect(maySendEvent).toHaveBeenCalledWith(
			"org.matrix.msc4143.rtc.member",
			"@alice:example.org",
		);
		expect(canPublishMembership(client as never, "!room", false)).toBe(false);
		membership = "leave";
		expect(canPublishMembership(client as never, "!room", true)).toBe(false);
	});
});
