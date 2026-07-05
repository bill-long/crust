import { createEffect, createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPersistedSignal,
	loadPersisted,
	safeLocalStorage,
	savePersisted,
} from "./persistedSignal";

// Accept any object with a numeric `n`, else fall back to the initial.
const parseCounter = (raw: unknown): { n: number } =>
	typeof raw === "object" &&
	raw !== null &&
	typeof (raw as { n: unknown }).n === "number"
		? { n: (raw as { n: number }).n }
		: { n: 0 };

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("safeLocalStorage", () => {
	it("round-trips get/set/remove", () => {
		safeLocalStorage.set("crust:k", "v");
		expect(safeLocalStorage.get("crust:k")).toBe("v");
		safeLocalStorage.remove("crust:k");
		expect(safeLocalStorage.get("crust:k")).toBeNull();
	});

	it("swallows errors from a throwing storage (returns null / no-op)", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceeded");
		});
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new Error("nope");
		});
		expect(safeLocalStorage.get("crust:x")).toBeNull();
		expect(() => safeLocalStorage.set("crust:x", "v")).not.toThrow();
		expect(() => safeLocalStorage.remove("crust:x")).not.toThrow();
	});
});

describe("loadPersisted / savePersisted", () => {
	it("round-trips a value through save then load", () => {
		savePersisted("crust:c", { n: 8 });
		expect(loadPersisted("crust:c", parseCounter, { n: 0 })).toEqual({ n: 8 });
	});

	it("returns initial for absent, non-JSON, and structurally invalid values", () => {
		expect(loadPersisted("crust:absent", parseCounter, { n: 1 })).toEqual({
			n: 1,
		});
		localStorage.setItem("crust:c", "not json {");
		expect(loadPersisted("crust:c", parseCounter, { n: 1 })).toEqual({ n: 1 });
		localStorage.setItem("crust:c", JSON.stringify({ n: "x" }));
		expect(loadPersisted("crust:c", parseCounter, { n: 2 })).toEqual({ n: 0 });
	});
});

describe("createPersistedSignal", () => {
	it("uses the initial value when nothing is stored", () => {
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		expect(s.get()).toEqual({ n: 0 });
	});

	it("loads a valid persisted value at creation", () => {
		localStorage.setItem("crust:c", JSON.stringify({ n: 7 }));
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		expect(s.get()).toEqual({ n: 7 });
	});

	it("falls back to initial for non-JSON contents", () => {
		localStorage.setItem("crust:c", "not json {");
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		expect(s.get()).toEqual({ n: 0 });
	});

	it("uses parse's fallback for structurally invalid JSON", () => {
		localStorage.setItem("crust:c", JSON.stringify({ n: "nope" }));
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		expect(s.get()).toEqual({ n: 0 });
	});

	it("set() updates the signal and persists the exact JSON", () => {
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		s.set({ n: 3 });
		expect(s.get()).toEqual({ n: 3 });
		expect(localStorage.getItem("crust:c")).toBe(JSON.stringify({ n: 3 }));
	});

	it("set() supports a functional updater", () => {
		const s = createPersistedSignal("crust:c", parseCounter, { n: 1 });
		s.set((prev) => ({ n: prev.n + 4 }));
		expect(s.get()).toEqual({ n: 5 });
		expect(localStorage.getItem("crust:c")).toBe(JSON.stringify({ n: 5 }));
	});

	it("skips persistence when an updater returns the previous value", () => {
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		s.set({ n: 3 });
		localStorage.setItem("crust:c", "SENTINEL"); // detect a rewrite
		s.set((prev) => prev); // no-op updater
		expect(localStorage.getItem("crust:c")).toBe("SENTINEL");
		expect(s.get()).toEqual({ n: 3 });
	});

	it("reset() restores the initial value and clears storage", () => {
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		s.set({ n: 9 });
		s.reset();
		expect(s.get()).toEqual({ n: 0 });
		expect(localStorage.getItem("crust:c")).toBeNull();
	});

	it("set() from inside an effect does not subscribe that effect to the store", async () => {
		// The lastRoom/lastChannel recording effects in Layout call these setters
		// from inside a createEffect and must stay write-only - reading the value
		// tracked would re-run them on every store change.
		const s = createPersistedSignal("crust:c", parseCounter, { n: 0 });
		let runs = 0;
		let dispose = () => {};
		createRoot((d) => {
			dispose = d;
			createEffect(() => {
				runs++;
				// Write-only; guarded so a re-run would be a referential no-op.
				s.set((prev) => (prev.n === 5 ? prev : { n: 5 }));
			});
		});
		await Promise.resolve();
		const afterInit = runs;

		// External write. If set() subscribed the effect via a tracked get(),
		// this would re-run it; with untrack it must not.
		s.set({ n: 9 });
		await Promise.resolve();
		dispose();

		expect(runs).toBe(afterInit);
		expect(s.get()).toEqual({ n: 9 });
	});

	describe("legacy key migration", () => {
		it("adopts the legacy value under the new key and removes the legacy key", () => {
			localStorage.setItem("crust_c", JSON.stringify({ n: 5 }));
			const s = createPersistedSignal(
				"crust:c",
				parseCounter,
				{ n: 0 },
				{
					legacyKey: "crust_c",
				},
			);
			expect(s.get()).toEqual({ n: 5 });
			expect(localStorage.getItem("crust:c")).toBe(JSON.stringify({ n: 5 }));
			expect(localStorage.getItem("crust_c")).toBeNull();
		});

		it("prefers the new key and leaves the legacy key untouched", () => {
			localStorage.setItem("crust:c", JSON.stringify({ n: 2 }));
			localStorage.setItem("crust_c", JSON.stringify({ n: 5 }));
			const s = createPersistedSignal(
				"crust:c",
				parseCounter,
				{ n: 0 },
				{
					legacyKey: "crust_c",
				},
			);
			expect(s.get()).toEqual({ n: 2 });
			expect(localStorage.getItem("crust_c")).toBe(JSON.stringify({ n: 5 }));
		});
	});
});
