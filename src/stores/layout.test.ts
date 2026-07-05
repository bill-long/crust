import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The layout store is a module-level singleton whose signal is initialized
// from localStorage at import time. To exercise the load-at-import branches we
// reset the module registry and re-import with localStorage pre-seeded.
const STORAGE_KEY = "crust:layout";

async function freshModule(): Promise<typeof import("./layout")> {
	vi.resetModules();
	return import("./layout");
}

beforeEach(() => localStorage.clear());
afterEach(() => {
	localStorage.clear();
	vi.resetModules();
});

describe("layout store: load at import", () => {
	it("defaults membersPaneVisible to false when storage is empty", async () => {
		const m = await freshModule();
		expect(m.membersPaneVisible()).toBe(false);
	});

	it("restores a persisted true value", async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ membersPaneVisible: true }),
		);
		const m = await freshModule();
		expect(m.membersPaneVisible()).toBe(true);
	});

	it("falls back to defaults for non-JSON contents", async () => {
		localStorage.setItem(STORAGE_KEY, "not json {");
		const m = await freshModule();
		expect(m.membersPaneVisible()).toBe(false);
	});

	it("falls back to defaults for non-object JSON", async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
		const m = await freshModule();
		expect(m.membersPaneVisible()).toBe(false);
	});

	it("falls back to the default when the field is not a boolean", async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ membersPaneVisible: "yes" }),
		);
		const m = await freshModule();
		expect(m.membersPaneVisible()).toBe(false);
	});
});

describe("layout store: mutations", () => {
	it("setMembersPaneVisible updates the value and persists it", async () => {
		const m = await freshModule();
		m.setMembersPaneVisible(true);
		expect(m.membersPaneVisible()).toBe(true);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(
			JSON.stringify({ membersPaneVisible: true }),
		);
		m.setMembersPaneVisible(false);
		expect(m.membersPaneVisible()).toBe(false);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(
			JSON.stringify({ membersPaneVisible: false }),
		);
	});

	it("toggleMembersPane flips the value and persists each flip", async () => {
		const m = await freshModule();
		expect(m.membersPaneVisible()).toBe(false);

		m.toggleMembersPane();
		expect(m.membersPaneVisible()).toBe(true);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(
			JSON.stringify({ membersPaneVisible: true }),
		);

		m.toggleMembersPane();
		expect(m.membersPaneVisible()).toBe(false);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(
			JSON.stringify({ membersPaneVisible: false }),
		);
	});

	it("persists a value that a subsequent fresh import restores", async () => {
		const m1 = await freshModule();
		m1.setMembersPaneVisible(true);
		// A brand-new import (e.g. next app load) must see the persisted value.
		const m2 = await freshModule();
		expect(m2.membersPaneVisible()).toBe(true);
	});

	it("updates in memory without throwing when persistence fails", async () => {
		const m = await freshModule();
		// Simulate quota-exceeded / disabled storage (e.g. private mode): save()
		// is best-effort and must not crash the pane toggle.
		const setItemSpy = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("QuotaExceededError");
			});
		try {
			expect(() => m.setMembersPaneVisible(true)).not.toThrow();
			// The reactive value still reflects the change even though the write
			// was dropped.
			expect(m.membersPaneVisible()).toBe(true);
			expect(() => m.toggleMembersPane()).not.toThrow();
			expect(m.membersPaneVisible()).toBe(false);
		} finally {
			setItemSpy.mockRestore();
		}
	});
});
