import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetAppModalStackForTests,
	appModalOpen,
	popAppModal,
	pushAppModal,
	trackAppModalMounted,
	trackAppModalOpen,
} from "./modalStack";

describe("modalStack", () => {
	afterEach(() => {
		_resetAppModalStackForTests();
	});

	it("starts closed", () => {
		expect(appModalOpen()).toBe(false);
	});

	it("opens after a single push", () => {
		pushAppModal();
		expect(appModalOpen()).toBe(true);
	});

	it("closes after balanced push/pop", () => {
		pushAppModal();
		popAppModal();
		expect(appModalOpen()).toBe(false);
	});

	it("stays open while nested modals are layered", () => {
		pushAppModal();
		pushAppModal();
		expect(appModalOpen()).toBe(true);
		popAppModal();
		expect(appModalOpen()).toBe(true);
		popAppModal();
		expect(appModalOpen()).toBe(false);
	});

	it("clamps count to zero on extra pops (defensive)", () => {
		popAppModal();
		popAppModal();
		expect(appModalOpen()).toBe(false);
		pushAppModal();
		expect(appModalOpen()).toBe(true);
	});

	describe("trackAppModalMounted", () => {
		it("pushes on mount and pops on dispose", () => {
			const dispose = createRoot((d) => {
				trackAppModalMounted();
				return d;
			});
			expect(appModalOpen()).toBe(true);
			dispose();
			expect(appModalOpen()).toBe(false);
		});

		it("stacks correctly across multiple mounted instances", () => {
			const dispose1 = createRoot((d) => {
				trackAppModalMounted();
				return d;
			});
			const dispose2 = createRoot((d) => {
				trackAppModalMounted();
				return d;
			});
			expect(appModalOpen()).toBe(true);
			dispose1();
			expect(appModalOpen()).toBe(true);
			dispose2();
			expect(appModalOpen()).toBe(false);
		});
	});

	describe("trackAppModalOpen", () => {
		it("tracks open->close transitions", () => {
			const [open, setOpen] = createSignal(false);
			const dispose = createRoot((d) => {
				trackAppModalOpen(open);
				return d;
			});
			expect(appModalOpen()).toBe(false);
			setOpen(true);
			expect(appModalOpen()).toBe(true);
			setOpen(false);
			expect(appModalOpen()).toBe(false);
			setOpen(true);
			expect(appModalOpen()).toBe(true);
			dispose();
			expect(appModalOpen()).toBe(false);
		});

		it("pushes immediately when initial value is true", () => {
			const [open] = createSignal(true);
			const dispose = createRoot((d) => {
				trackAppModalOpen(open);
				return d;
			});
			expect(appModalOpen()).toBe(true);
			dispose();
			expect(appModalOpen()).toBe(false);
		});

		it("pops on dispose-while-open without double-popping", () => {
			const [open, setOpen] = createSignal(true);
			const dispose = createRoot((d) => {
				trackAppModalOpen(open);
				return d;
			});
			expect(appModalOpen()).toBe(true);
			// Dispose while still "open" — cleanup must pop once.
			dispose();
			expect(appModalOpen()).toBe(false);
			// Setting the signal after dispose must not affect the counter
			// (effect has been disposed).
			setOpen(false);
			expect(appModalOpen()).toBe(false);
			setOpen(true);
			expect(appModalOpen()).toBe(false);
		});

		it("does not pop on dispose if already closed (balanced)", () => {
			const [open, setOpen] = createSignal(false);
			const dispose = createRoot((d) => {
				trackAppModalOpen(open);
				return d;
			});
			setOpen(true);
			setOpen(false);
			expect(appModalOpen()).toBe(false);
			// A sibling push must not be cancelled by an over-eager cleanup.
			pushAppModal();
			expect(appModalOpen()).toBe(true);
			dispose();
			expect(appModalOpen()).toBe(true);
			popAppModal();
			expect(appModalOpen()).toBe(false);
		});
	});
});
