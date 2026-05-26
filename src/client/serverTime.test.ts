import type { MatrixEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createServerTimeTracker,
	MATERIAL_OFFSET_CHANGE_MS,
} from "./serverTime";

const NOW = 1_780_000_000_000;

function makeEvent(opts: {
	originServerTs: number;
	age?: number | string | undefined;
	noUnsigned?: boolean;
}): MatrixEvent {
	const unsigned = opts.noUnsigned
		? undefined
		: opts.age === undefined
			? {}
			: { age: opts.age };
	// localTimestamp is set by the SDK as `Date.now() - (age ?? 0)`.
	const baseAge = typeof opts.age === "number" ? opts.age : 0;
	const localTimestamp = Date.now() - baseAge;
	return {
		event: { unsigned },
		getTs: () => opts.originServerTs,
		localTimestamp,
	} as unknown as MatrixEvent;
}

describe("createServerTimeTracker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns Date.now() before any sample arrives", () => {
		const t = createServerTimeTracker();
		expect(t.getOffsetMs()).toBe(0);
		expect(t.now()).toBe(NOW);
	});

	it("computes offset from a server-delivered event", () => {
		const t = createServerTimeTracker();
		// Server says event happened 30 minutes ago; client time at receipt
		// is NOW. localTimestamp = NOW - age. originServerTs is 30 minutes
		// *ahead* of our local clock (server clock is ahead by 30m).
		const age = 60_000; // event is 1 minute old per server
		const serverNowAtReceipt = NOW + 30 * 60_000; // server is 30m ahead
		const originServerTs = serverNowAtReceipt - age;
		const ev = makeEvent({ originServerTs, age });
		const sampled = t.sampleFromEvent(ev);
		expect(sampled).toBe(true);
		expect(t.getOffsetMs()).toBe(30 * 60_000);
		expect(t.now()).toBe(NOW + 30 * 60_000);
	});

	it("handles negative offset (server behind client clock)", () => {
		const t = createServerTimeTracker();
		const age = 5_000;
		const serverNowAtReceipt = NOW - 15 * 60_000; // server is 15m behind
		const originServerTs = serverNowAtReceipt - age;
		t.sampleFromEvent(makeEvent({ originServerTs, age }));
		expect(t.getOffsetMs()).toBe(-15 * 60_000);
		expect(t.now()).toBe(NOW - 15 * 60_000);
	});

	it("ignores events without unsigned.age (local echo / no age)", () => {
		const t = createServerTimeTracker();
		expect(
			t.sampleFromEvent(makeEvent({ originServerTs: NOW + 999_999 })),
		).toBe(false);
		expect(t.getOffsetMs()).toBe(0);
	});

	it("ignores events with no unsigned block at all", () => {
		const t = createServerTimeTracker();
		expect(
			t.sampleFromEvent(
				makeEvent({ originServerTs: NOW + 999_999, noUnsigned: true }),
			),
		).toBe(false);
		expect(t.getOffsetMs()).toBe(0);
	});

	it("ignores events with non-numeric age", () => {
		const t = createServerTimeTracker();
		expect(
			t.sampleFromEvent(
				makeEvent({ originServerTs: NOW + 999_999, age: "garbage" }),
			),
		).toBe(false);
		expect(t.getOffsetMs()).toBe(0);
	});

	it("ignores events with non-finite timestamps", () => {
		const t = createServerTimeTracker();
		const ev = {
			event: { unsigned: { age: 100 } },
			getTs: () => Number.NaN,
			localTimestamp: NOW - 100,
		} as unknown as MatrixEvent;
		expect(t.sampleFromEvent(ev)).toBe(false);
		expect(t.getOffsetMs()).toBe(0);
	});

	it("updates the offset even when the shift is below the material threshold", () => {
		const t = createServerTimeTracker();
		// First sample: 0 -> 60s offset.
		const age = 0;
		t.sampleFromEvent(makeEvent({ originServerTs: NOW + 60_000, age }));
		expect(t.getOffsetMs()).toBe(60_000);
		// Second sample shifts the offset by 500ms (below 1000ms threshold).
		// The tracker still consumes the sample (returns true) and updates
		// the offset; material-change gating is the caller's responsibility.
		const sampled = t.sampleFromEvent(
			makeEvent({ originServerTs: NOW + 60_500, age }),
		);
		expect(sampled).toBe(true);
		expect(t.getOffsetMs()).toBe(60_500);
	});

	it(`MATERIAL_OFFSET_CHANGE_MS is exported for callers to gate refreshes (${MATERIAL_OFFSET_CHANGE_MS}ms)`, () => {
		expect(MATERIAL_OFFSET_CHANGE_MS).toBe(1000);
		const t = createServerTimeTracker();
		const age = 0;
		t.sampleFromEvent(makeEvent({ originServerTs: NOW + 60_000, age }));
		const before = t.getOffsetMs();
		t.sampleFromEvent(
			makeEvent({
				originServerTs: NOW + 60_000 + MATERIAL_OFFSET_CHANGE_MS,
				age,
			}),
		);
		const after = t.getOffsetMs();
		expect(Math.abs(after - before)).toBe(MATERIAL_OFFSET_CHANGE_MS);
	});

	it("latest sample wins (no smoothing)", () => {
		const t = createServerTimeTracker();
		const age = 0;
		t.sampleFromEvent(makeEvent({ originServerTs: NOW + 60_000, age }));
		t.sampleFromEvent(makeEvent({ originServerTs: NOW - 60_000, age }));
		expect(t.getOffsetMs()).toBe(-60_000);
	});
});
