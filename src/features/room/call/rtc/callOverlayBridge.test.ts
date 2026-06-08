import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CallOverlaySnapshot,
	createCallOverlayConsumer,
	createCallOverlayProducer,
} from "./callOverlayBridge";

/**
 * BroadcastChannel delivers cross-context messages on a later task, and a
 * request/answer handshake takes two hops. Poll until a condition holds rather
 * than assuming a fixed number of turns.
 */
const until = async (predicate: () => boolean): Promise<void> => {
	for (let i = 0; i < 50; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

const snapshot = (
	over: Partial<CallOverlaySnapshot> = {},
): CallOverlaySnapshot => ({
	active: true,
	roomName: "General",
	participants: [
		{
			identity: "a",
			displayName: "Alice",
			avatarUrl: null,
			isLocal: false,
			isMuted: false,
			isSpeaking: false,
		},
	],
	...over,
});

describe("callOverlayBridge", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const c of cleanups.splice(0)) c();
	});

	it("delivers published snapshots from producer to consumer", async () => {
		const producer = createCallOverlayProducer({
			getSnapshot: () => snapshot(),
			onLeave: () => {},
		});
		cleanups.push(producer.dispose);
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		// Let the request/answer handshake settle first so the later publish
		// isn't racing the in-flight handshake reply on the shared channel.
		await until(() => consumer.snapshot().active);

		producer.publish(snapshot({ roomName: "Gaming" }));
		await until(() => consumer.snapshot().roomName === "Gaming");

		expect(consumer.snapshot().active).toBe(true);
		expect(consumer.snapshot().roomName).toBe("Gaming");
		expect(consumer.snapshot().participants[0]?.displayName).toBe("Alice");
	});

	it("answers a new consumer's request handshake with the current snapshot", async () => {
		const producer = createCallOverlayProducer({
			getSnapshot: () => snapshot({ roomName: "Already running" }),
			onLeave: () => {},
		});
		cleanups.push(producer.dispose);

		// Consumer mounts after the producer and should pull current state via
		// its one-shot "request" without waiting for the next publish.
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		await until(() => consumer.snapshot().roomName === "Already running");

		expect(consumer.snapshot().roomName).toBe("Already running");
	});

	it("forwards a consumer leave command to the producer's onLeave", async () => {
		const onLeave = vi.fn();
		const producer = createCallOverlayProducer({
			getSnapshot: () => snapshot(),
			onLeave,
		});
		cleanups.push(producer.dispose);
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		// The consumer must bind to the producer (via the active handshake)
		// before its leave is addressed to that producer's id.
		await until(() => consumer.snapshot().active);

		consumer.sendLeave();
		await until(() => onLeave.mock.calls.length > 0);

		expect(onLeave).toHaveBeenCalledTimes(1);
	});

	it("starts the consumer at the inactive snapshot", () => {
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		expect(consumer.snapshot().active).toBe(false);
		expect(consumer.snapshot().participants).toHaveLength(0);
	});

	it("ignores malformed snapshot payloads from the channel", async () => {
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		// A rogue same-origin sender posts a structurally-invalid snapshot.
		const rogue = new BroadcastChannel("crust:call-overlay");
		cleanups.push(() => rogue.close());
		rogue.postMessage({
			kind: "snapshot",
			producerId: "p1",
			snapshot: { active: true, roomName: 42, participants: "nope" },
		});
		await until(() => false); // give the channel time to (not) apply it

		expect(consumer.snapshot().active).toBe(false);
		expect(consumer.snapshot().roomName).toBe("");
	});

	it("rejects a sparse participants array (holes would deref as undefined)", async () => {
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		const rogue = new BroadcastChannel("crust:call-overlay");
		cleanups.push(() => rogue.close());
		// `new Array(2)` is a length-2 array of holes; Array.prototype.every
		// skips holes, so weak validation would accept it and feed undefined
		// rows into the view.
		rogue.postMessage({
			kind: "snapshot",
			producerId: "p1",
			snapshot: { active: true, roomName: "x", participants: new Array(2) },
		});
		await until(() => false);

		expect(consumer.snapshot().active).toBe(false);
		expect(consumer.snapshot().participants).toHaveLength(0);
	});

	it("does not let a payload __proto__ key pollute store prototypes", async () => {
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		const rogue = new BroadcastChannel("crust:call-overlay");
		cleanups.push(() => rogue.close());
		// JSON.parse creates a real own "__proto__" property (unlike a literal).
		const payload = JSON.parse(
			'{"kind":"snapshot","producerId":"p1","snapshot":{"active":true,"roomName":"x","participants":[],"__proto__":{"polluted":true}}}',
		);
		rogue.postMessage(payload);
		await until(() => consumer.snapshot().active);

		const proto = Object.getPrototypeOf(consumer.snapshot()) as Record<
			string,
			unknown
		>;
		expect(proto.polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("does not answer a handshake from an idle (inactive) producer", async () => {
		const producer = createCallOverlayProducer({
			getSnapshot: () => snapshot({ active: false }),
			onLeave: () => {},
		});
		cleanups.push(producer.dispose);
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		await until(() => false);

		// The inactive producer must stay silent, so the overlay shows no call.
		expect(consumer.snapshot().active).toBe(false);
	});

	it("ignores an inactive snapshot from a producer it is not bound to", async () => {
		const consumer = createCallOverlayConsumer();
		cleanups.push(consumer.dispose);
		const rogue = new BroadcastChannel("crust:call-overlay");
		cleanups.push(() => rogue.close());
		// Bind the consumer to producer "A" (active call).
		rogue.postMessage({
			kind: "snapshot",
			producerId: "A",
			snapshot: snapshot({ roomName: "A-call" }),
		});
		await until(() => consumer.snapshot().active);
		expect(consumer.snapshot().roomName).toBe("A-call");

		// A different tab "B" ending its own call must not blank A's overlay.
		rogue.postMessage({
			kind: "snapshot",
			producerId: "B",
			snapshot: { active: false, roomName: "", participants: [] },
		});
		await until(() => false);

		expect(consumer.snapshot().active).toBe(true);
		expect(consumer.snapshot().roomName).toBe("A-call");
	});

	it("ignores a leave command addressed to a different producer", async () => {
		const onLeave = vi.fn();
		const producer = createCallOverlayProducer({
			getSnapshot: () => snapshot(),
			onLeave,
		});
		cleanups.push(producer.dispose);
		const rogue = new BroadcastChannel("crust:call-overlay");
		cleanups.push(() => rogue.close());
		rogue.postMessage({
			kind: "command",
			command: "leave",
			producerId: "someone-else",
		});
		await until(() => false);

		expect(onLeave).not.toHaveBeenCalled();
	});
});
