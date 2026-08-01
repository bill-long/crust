import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPresenceCue,
	PRESENCE_COALESCE_MS,
	type PresenceCueDeps,
} from "./callPresenceCue";

/**
 * Drives `createPresenceCue` with a fully injected clock so every flush is
 * explicit. Nothing here touches an AudioContext - the synthesis lives in
 * `notificationSound.ts` and is only reached through the `play` spy.
 */
function setup(overrides: Partial<PresenceCueDeps> = {}): {
	cue: ReturnType<typeof createPresenceCue>;
	play: ReturnType<typeof vi.fn>;
	setRoster: (ids: string[]) => void;
	setLive: (live: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	/** Runs the pending coalesced flush, if one is scheduled. */
	tick: () => void;
	pendingCount: () => number;
} {
	let roster: string[] = [];
	let live = true;
	let enabled = true;
	const play = vi.fn();

	// Minimal timer stand-in: at most one pending callback, fired by `tick()`.
	const timers = new Map<number, () => void>();
	let nextHandle = 1;

	const cue = createPresenceCue({
		roster: () => roster,
		isLive: () => live,
		enabled: () => enabled,
		play,
		setTimer: (fn, ms) => {
			expect(ms).toBe(PRESENCE_COALESCE_MS);
			const handle = nextHandle++;
			timers.set(handle, fn);
			return handle as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle) => {
			timers.delete(handle as unknown as number);
		},
		...overrides,
	});

	return {
		cue,
		play,
		setRoster: (ids) => {
			roster = ids;
		},
		setLive: (v) => {
			live = v;
		},
		setEnabled: (v) => {
			enabled = v;
		},
		tick: () => {
			const entries = [...timers.entries()];
			timers.clear();
			for (const [, fn] of entries) fn();
		},
		pendingCount: () => timers.size,
	};
}

describe("createPresenceCue", () => {
	let h: ReturnType<typeof setup>;

	beforeEach(() => {
		h = setup();
	});

	it("stays silent until armed", () => {
		h.setRoster(["alice"]);
		h.cue.schedule();
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
		// `schedule` before `arm` must not even open a window.
		expect(h.pendingCount()).toBe(0);
	});

	it("treats participants present at arm time as already known", () => {
		h.setRoster(["alice", "bob"]);
		h.cue.arm();
		h.cue.schedule();
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
	});

	it("plays a join cue when a new identity appears", () => {
		h.cue.arm();
		h.setRoster(["alice"]);
		h.cue.schedule();
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: true,
			leave: false,
		});
	});

	it("plays a leave cue when a known identity disappears", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.setRoster([]);
		h.cue.schedule();
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: false,
			leave: true,
		});
	});

	it("plays a leave cue when the last remote participant leaves", () => {
		h.setRoster(["alice", "bob"]);
		h.cue.arm();
		h.setRoster(["alice"]);
		h.cue.schedule();
		h.tick();
		h.setRoster([]);
		h.cue.schedule();
		h.tick();
		expect(h.play).toHaveBeenCalledTimes(2);
		expect(h.play).toHaveBeenLastCalledWith({ join: false, leave: true });
	});

	it("coalesces a burst of joins into one cue", () => {
		h.cue.arm();
		// Three arrivals inside one window: each fires an event, but the
		// window is already open so only the first opens a timer.
		h.setRoster(["alice"]);
		h.cue.schedule();
		h.setRoster(["alice", "bob"]);
		h.cue.schedule();
		h.setRoster(["alice", "bob", "carol"]);
		h.cue.schedule();
		expect(h.pendingCount()).toBe(1);
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: true,
			leave: false,
		});
	});

	it("reports both directions when a join and a leave share a window", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.setRoster(["bob"]);
		h.cue.schedule();
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: true,
			leave: true,
		});
	});

	it("stays silent and preserves the baseline across a reconnect", () => {
		h.setRoster(["alice", "bob"]);
		h.cue.arm();

		// `handleRestarting` drops every remote participant, then LiveKit
		// flips to Reconnecting.
		h.setRoster([]);
		h.cue.schedule();
		h.setLive(false);
		h.tick();
		expect(h.play).not.toHaveBeenCalled();

		// Reconnected: the buffered ParticipantConnected events replay and the
		// roster comes back unchanged. The baseline was never clobbered by the
		// deferred flush, so this diffs to nothing.
		h.setRoster(["alice", "bob"]);
		h.setLive(true);
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
	});

	it("still announces someone who actually joined during a reconnect", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.setRoster([]);
		h.cue.schedule();
		h.setLive(false);
		h.tick();

		h.setRoster(["alice", "bob"]);
		h.setLive(true);
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: true,
			leave: false,
		});
	});

	it("keeps retrying while not live, and reconciles without a new event", () => {
		h.setRoster(["alice"]);
		h.cue.arm();

		// Reconnect starts; the roster empties and liveness drops.
		h.setRoster([]);
		h.cue.schedule();
		h.setLive(false);

		// Several windows pass with the room still down. Each one must re-open
		// so recovery doesn't depend on some unrelated later event.
		for (let i = 0; i < 3; i++) {
			h.tick();
			expect(h.play).not.toHaveBeenCalled();
			expect(h.pendingCount()).toBe(1);
		}

		// Alice actually hung up during the outage, so the post-reconnect
		// roster is empty and no buffered join event replays for her. The
		// retry is the only thing that can notice, and it must announce the
		// leave now rather than attaching it to a much later unrelated join.
		h.setLive(true);
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: false,
			leave: true,
		});
	});

	it("stops retrying once reset disarms it", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.cue.schedule();
		h.setLive(false);
		h.tick();
		expect(h.pendingCount()).toBe(1);

		h.cue.reset();
		expect(h.pendingCount()).toBe(0);
		h.tick();
		expect(h.pendingCount()).toBe(0);
		expect(h.play).not.toHaveBeenCalled();
	});

	it("goes silent after reset and drops any pending window", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.setRoster([]);
		h.cue.schedule();
		h.cue.reset();
		expect(h.pendingCount()).toBe(0);
		h.tick();
		expect(h.play).not.toHaveBeenCalled();

		// Post-reset events must not re-open a window either.
		h.setRoster(["bob"]);
		h.cue.schedule();
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
	});

	it("does not play while the setting is off", () => {
		h.setEnabled(false);
		h.cue.arm();
		h.setRoster(["alice"]);
		h.cue.schedule();
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
	});

	it("does not replay changes that happened while the setting was off", () => {
		h.setEnabled(false);
		h.cue.arm();
		h.setRoster(["alice", "bob"]);
		h.cue.schedule();
		h.tick();

		// Re-enabling mid-call must not announce the two who arrived while it
		// was off - the baseline tracked them even though nothing sounded.
		h.setEnabled(true);
		h.cue.schedule();
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
	});

	it("re-seeds the baseline on a second arm without sounding", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.setRoster(["bob", "carol"]);
		h.cue.arm();
		h.cue.schedule();
		h.tick();
		expect(h.play).not.toHaveBeenCalled();
	});
});
