import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { sendSerializedPollEvent } from "./pollSdk";

function makeClient() {
	return {
		sendEvent: vi.fn().mockResolvedValue({ event_id: "$sent" }),
	};
}

const pollEvent = {
	serialize: () => ({
		type: "org.matrix.msc3381.poll.start",
		content: { "org.matrix.msc3381.poll.start": { question: "q" } },
	}),
};

describe("sendSerializedPollEvent", () => {
	it("sends with an explicit null threadId by default (main timeline)", async () => {
		const client = makeClient();
		await sendSerializedPollEvent(
			client as unknown as MatrixClient,
			"!r:hs",
			pollEvent,
		);
		expect(client.sendEvent).toHaveBeenCalledWith(
			"!r:hs",
			null,
			"org.matrix.msc3381.poll.start",
			{ "org.matrix.msc3381.poll.start": { question: "q" } },
		);
	});

	it("forwards threadId so the SDK's thread overload routes the send (#332)", async () => {
		const client = makeClient();
		await sendSerializedPollEvent(
			client as unknown as MatrixClient,
			"!r:hs",
			pollEvent,
			{ threadId: "$root:hs" },
		);
		expect(client.sendEvent.mock.calls[0][1]).toBe("$root:hs");
	});

	it("lets extraContent add keys but never override serialized ones", async () => {
		const client = makeClient();
		await sendSerializedPollEvent(
			client as unknown as MatrixClient,
			"!r:hs",
			pollEvent,
			{
				extraContent: {
					"com.example.block": { extra: true },
					"org.matrix.msc3381.poll.start": { question: "OVERRIDE" },
				},
			},
		);
		const content = client.sendEvent.mock.calls[0][3] as Record<
			string,
			unknown
		>;
		expect(content["com.example.block"]).toEqual({ extra: true });
		// The serializer's block wins over a colliding extraContent key.
		expect(content["org.matrix.msc3381.poll.start"]).toEqual({
			question: "q",
		});
	});
});
