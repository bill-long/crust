import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSetting, userSettings } from "../../../stores/settings";
import { CallOverlay } from "./CallOverlay";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function renderOverlay(onClose: () => void = () => undefined) {
	return render(() => (
		<CallOverlay
			elementCallUrl="https://call.example.com"
			roomId="!room:example.com"
			roomName="Alpha"
			onClose={onClose}
		/>
	));
}

describe("CallOverlay focus-trap sentinels (iframe path)", () => {
	let previousUseNative: boolean;

	beforeEach(() => {
		previousUseNative = userSettings().useNativeCalls;
		// Focus-trap tests target the iframe path. Phase 5 (#122) defaults
		// useNativeCalls to true; opt back into the iframe explicitly.
		updateSetting("useNativeCalls", false);
	});

	afterEach(() => {
		cleanup();
		updateSetting("useNativeCalls", previousUseNative);
	});

	it("renders a focusable leading sentinel before the iframe and a trailing one after", () => {
		renderOverlay();
		const iframe = screen.getByTitle("Element Call — Alpha");
		const dialog = screen.getByRole("dialog");
		const sentinels = Array.from(
			dialog.querySelectorAll<HTMLElement>('div[tabindex="0"]'),
		);
		expect(sentinels).toHaveLength(2);
		const [leading, trailing] = sentinels;
		// Both sentinels are non-visible (sr-only) but focusable.
		expect(leading.classList.contains("sr-only")).toBe(true);
		expect(trailing.classList.contains("sr-only")).toBe(true);
		// Ordering: leading sits before the iframe, trailing after.
		expect(
			leading.compareDocumentPosition(iframe) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			iframe.compareDocumentPosition(trailing) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("focusing the leading sentinel redirects focus into the iframe", () => {
		renderOverlay();
		const iframe = screen.getByTitle(
			"Element Call — Alpha",
		) as HTMLIFrameElement;
		const focusSpy = vi.spyOn(iframe, "focus");
		const leading = screen
			.getByRole("dialog")
			.querySelector<HTMLElement>('div[tabindex="0"]');
		if (!leading) throw new Error("leading sentinel not found");
		fireEvent.focus(leading);
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it("focusing the trailing sentinel redirects focus to the close button", () => {
		renderOverlay();
		const closeButton = screen.getByRole("button", { name: "Close call" });
		const focusSpy = vi.spyOn(closeButton, "focus");
		const sentinels = screen
			.getByRole("dialog")
			.querySelectorAll<HTMLElement>('div[tabindex="0"]');
		const trailing = sentinels[sentinels.length - 1];
		fireEvent.focus(trailing);
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});
});

describe("CallOverlay useNativeCalls gating (Phase 5, #122)", () => {
	let previousUseNative: boolean;

	beforeEach(() => {
		previousUseNative = userSettings().useNativeCalls;
	});

	afterEach(() => {
		cleanup();
		vi.resetModules();
		vi.doUnmock("./rtc/NativeCallView");
		updateSetting("useNativeCalls", previousUseNative);
	});

	it("renders NativeCallView and not the iframe when useNativeCalls is true", async () => {
		vi.resetModules();
		vi.doMock("./rtc/NativeCallView", () => ({
			NativeCallView: (props: { roomName: string }) => (
				<div data-testid="native-call-view">native:{props.roomName}</div>
			),
		}));
		const settingsModule = await import("../../../stores/settings");
		settingsModule.updateSetting("useNativeCalls", true);
		const { CallOverlay: CallOverlayReloaded } = await import("./CallOverlay");
		render(() => (
			<CallOverlayReloaded
				elementCallUrl="https://call.example.com"
				roomId="!room:example.com"
				roomName="Alpha"
				onClose={() => undefined}
			/>
		));
		const view = screen.getByTestId("native-call-view");
		expect(view.textContent).toBe("native:Alpha");
		expect(screen.queryByTitle("Element Call — Alpha")).toBeNull();
		expect(screen.queryByRole("button", { name: "Close call" })).toBeNull();
	});

	it("renders the iframe when useNativeCalls is false", () => {
		updateSetting("useNativeCalls", false);
		renderOverlay();
		expect(screen.getByTitle("Element Call — Alpha")).toBeTruthy();
		expect(screen.queryByText(/native:/)).toBeNull();
	});

	it("does NOT swap to native when useNativeCalls is toggled on mid-call", async () => {
		// Snapshot-at-mount guarantee: flipping the setting while a call
		// is open must not tear down the iframe (avoids double-joining
		// the MatrixRTC session per #122 mutual-exclusion guardrail).
		vi.resetModules();
		vi.doMock("./rtc/NativeCallView", () => ({
			NativeCallView: () => <div data-testid="native-call-view">native</div>,
		}));
		const settingsModule = await import("../../../stores/settings");
		settingsModule.updateSetting("useNativeCalls", false);
		const { CallOverlay: CallOverlayReloaded } = await import("./CallOverlay");
		render(() => (
			<CallOverlayReloaded
				elementCallUrl="https://call.example.com"
				roomId="!room:example.com"
				roomName="Alpha"
				onClose={() => undefined}
			/>
		));
		expect(screen.getByTitle("Element Call — Alpha")).toBeTruthy();

		// Flip the setting on. The active overlay should stay on the
		// iframe path; only the next open should pick up the change.
		settingsModule.updateSetting("useNativeCalls", true);
		expect(screen.getByTitle("Element Call — Alpha")).toBeTruthy();
		expect(screen.queryByTestId("native-call-view")).toBeNull();
	});
});
