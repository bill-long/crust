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
		h.cue.schedule();
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
		h.cue.schedule();
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: true,
			leave: false,
		});
	});

	it("does not poll while not live", () => {
		h.setRoster(["alice"]);
		h.cue.arm();
		h.cue.schedule();
		h.setLive(false);
		h.tick();

		// A suppressed flush must NOT re-arm itself. Recovery is the caller's
		// job (it re-schedules on connection-state changes); polling here
		// would run a timer for the whole outage.
		expect(h.pendingCount()).toBe(0);
		expect(h.play).not.toHaveBeenCalled();
	});

	it("announces a departure that happened during an outage, once rescheduled", () => {
		h.setRoster(["alice"]);
		h.cue.arm();

		// Reconnect starts; the roster empties and liveness drops.
		h.setRoster([]);
		h.cue.schedule();
		h.setLive(false);
		h.tick();
		expect(h.play).not.toHaveBeenCalled();

		// Alice actually hung up during the outage, so the post-reconnect
		// roster is empty and no buffered join event replays for her. The
		// caller's connection-state reschedule is the only thing that can
		// notice, and the preserved baseline makes it announce the leave now
		// rather than attaching it to a much later unrelated join.
		h.setLive(true);
		h.cue.schedule();
		h.tick();
		expect(h.play).toHaveBeenCalledExactlyOnceWith({
			join: false,
			leave: true,
		});
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

	describe("self join/leave", () => {
		it("cues immediately on self join, without waiting for a window", () => {
			h.cue.selfJoined();
			expect(h.play).toHaveBeenCalledExactlyOnceWith({
				join: true,
				leave: false,
			});
			expect(h.pendingCount()).toBe(0);
		});

		it("cues on self leave", () => {
			h.cue.selfJoined();
			h.play.mockClear();
			h.cue.selfLeft();
			expect(h.play).toHaveBeenCalledExactlyOnceWith({
				join: false,
				leave: true,
			});
		});

		it("does not re-announce a join across an internal reconnect", () => {
			h.cue.selfJoined();
			h.play.mockClear();

			// Focus-change teardown: reset() runs, but the user never left.
			h.cue.reset();
			h.cue.arm();
			h.cue.selfJoined();
			expect(h.play).not.toHaveBeenCalled();
		});

		it("stays silent on a teardown that never reached a joined call", () => {
			// Connect attempt dies before selfJoined() - e.g. the user denies
			// the mic and doConnect's catch tears down.
			h.cue.arm();
			h.cue.reset();
			h.cue.selfLeft();
			expect(h.play).not.toHaveBeenCalled();
		});

		it("does not emit a second leave for one departure", () => {
			h.cue.selfJoined();
			h.play.mockClear();
			h.cue.selfLeft();
			h.cue.selfLeft();
			expect(h.play).toHaveBeenCalledTimes(1);
		});

		it("announces a rejoin after leaving", () => {
			h.cue.selfJoined();
			h.cue.selfLeft();
			h.play.mockClear();
			h.cue.selfJoined();
			expect(h.play).toHaveBeenCalledExactlyOnceWith({
				join: true,
				leave: false,
			});
		});

		it("respects the setting in both directions", () => {
			h.setEnabled(false);
			h.cue.selfJoined();
			h.cue.selfLeft();
			expect(h.play).not.toHaveBeenCalled();

			// State still tracked while muted, so re-enabling mid-call does not
			// leave the next transition mis-paired.
			h.setEnabled(true);
			h.cue.selfJoined();
			expect(h.play).toHaveBeenCalledExactlyOnceWith({
				join: true,
				leave: false,
			});
		});
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
