import { afterEach, expect, it, vi } from "vitest";
import {
	createCallOverlayConsumer,
	createCallOverlayProducer,
	OVERLAY_LEASE_MS,
} from "./callOverlayBridge";

class Channel {
	static channels = new Set<Channel>();
	onmessage: ((event: MessageEvent) => void) | null = null;
	constructor() {
		Channel.channels.add(this);
	}
	postMessage(data: unknown): void {
		for (const channel of Channel.channels) {
			if (channel !== this) channel.onmessage?.({ data } as MessageEvent);
		}
	}
	close(): void {
		Channel.channels.delete(this);
	}
}

afterEach(() => {
	Channel.channels.clear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("keeps a quiet producer alive, expires a dead one, and discovers its replacement", () => {
	vi.useFakeTimers();
	vi.stubGlobal("BroadcastChannel", Channel);
	const producer = createCallOverlayProducer({
		getSnapshot: () => ({ active: true, roomName: "First", participants: [] }),
	});
	const consumer = createCallOverlayConsumer();
	expect(consumer.snapshot().roomName).toBe("First");
	vi.advanceTimersByTime(OVERLAY_LEASE_MS * 2);
	expect(consumer.snapshot().active).toBe(true);
	producer.dispose();
	vi.advanceTimersByTime(OVERLAY_LEASE_MS);
	expect(consumer.snapshot().active).toBe(false);
	expect(consumer.snapshot().participants).toEqual([]);
	const next = createCallOverlayProducer({
		getSnapshot: () => ({ active: true, roomName: "Next", participants: [] }),
	});
	next.publish({ active: true, roomName: "Next", participants: [] });
	expect(consumer.snapshot().roomName).toBe("Next");
	next.dispose();
	consumer.dispose();
	expect(vi.getTimerCount()).toBe(0);
});
