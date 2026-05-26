import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("CallOverlay focus-trap sentinels", () => {
	afterEach(cleanup);

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

describe("CallOverlay native RTC flag gating", () => {
	afterEach(() => {
		cleanup();
		vi.resetModules();
		vi.doUnmock("./rtc/nativeRtcEnabled");
		vi.doUnmock("./rtc/NativeCallView");
	});

	it("renders NativeCallView and not the iframe when NATIVE_RTC_ENABLED is true", async () => {
		vi.resetModules();
		vi.doMock("./rtc/nativeRtcEnabled", () => ({ NATIVE_RTC_ENABLED: true }));
		vi.doMock("./rtc/NativeCallView", () => ({
			NativeCallView: (props: { roomName: string }) => (
				<div data-testid="native-call-view">native:{props.roomName}</div>
			),
		}));
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
});
