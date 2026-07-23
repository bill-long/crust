import { createEffect, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createThreadPanelState } from "./threadPanelState";

describe("createThreadPanelState", () => {
	it("open() sets the thread and the jump target together", () => {
		createRoot((dispose) => {
			const state = createThreadPanelState();
			state.open("$rootB", "$replyB");
			expect(state.openThreadId()).toBe("$rootB");
			expect(state.threadJumpRequest()).toBe("$replyB");
			dispose();
		});
	});

	it("open() without a target replaces any unconsumed previous one", () => {
		createRoot((dispose) => {
			const state = createThreadPanelState();
			state.open("$rootA", "$replyA");
			state.open("$rootB");
			expect(state.openThreadId()).toBe("$rootB");
			expect(state.threadJumpRequest()).toBeNull();
			dispose();
		});
	});

	it("close() clears both; consumeJump() clears only the target", () => {
		createRoot((dispose) => {
			const state = createThreadPanelState();
			state.open("$root", "$reply");
			state.consumeJump();
			expect(state.openThreadId()).toBe("$root");
			expect(state.threadJumpRequest()).toBeNull();
			state.close();
			expect(state.openThreadId()).toBeNull();
			dispose();
		});
	});

	it("a cross-thread jump is not consumed by the OLD thread's mounted consumer", () => {
		// Regression: unbatched, effects flush between the two writes in
		// open(), so thread A's still-mounted TimelineView jump effect saw
		// the new request first - running a wrong-thread window load and
		// consuming the target - and thread B's panel mounted with nothing
		// to scroll to. Batched, A's consumer only ever observes the new
		// request alongside the new openThreadId and leaves it alone.
		//
		// The second open() runs OUTSIDE the createRoot body: the root's
		// synchronous setup is itself an implicit batch, so an in-body call
		// could not reproduce the per-write effect flush of a real DOM
		// event handler.
		const consumedByA: string[] = [];
		let state!: ReturnType<typeof createThreadPanelState>;
		const dispose = createRoot((d) => {
			state = createThreadPanelState();
			state.open("$rootA");

			// Mimic thread A's mounted TimelineView: consume any jump
			// request observed while A is the open thread (the real effect
			// is keyed under <Show> on openThreadId, so it only exists -
			// and only consumes - while its own thread is the open one).
			createEffect(() => {
				const id = state.threadJumpRequest();
				if (id !== null && state.openThreadId() === "$rootA") {
					consumedByA.push(id);
					state.consumeJump();
				}
			});
			return d;
		});

		state.open("$rootB", "$replyB");
		expect(consumedByA).toEqual([]);
		expect(state.openThreadId()).toBe("$rootB");
		expect(state.threadJumpRequest()).toBe("$replyB");
		dispose();
	});
});
