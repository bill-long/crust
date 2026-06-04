import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCryptoDialogOpen } from "../../../../stores/cryptoActions";
import {
	_resetAppModalStackForTests,
	pushAppModal,
} from "../../../../stores/modalStack";
import {
	_resetVoiceForTests,
	setUserWantsMic,
	userWantsMic,
} from "../../../../stores/voice";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./callSessionStore";
import { FullCallOverlay } from "./FullCallOverlay";
import { makeFakeCallSession } from "./fakeCallSession.test-utils";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

describe("FullCallOverlay", () => {
	const fakes: Array<{ dispose: () => void }> = [];
	const track = <T extends { dispose: () => void }>(fake: T): T => {
		fakes.push(fake);
		return fake;
	};

	afterEach(() => {
		cleanup();
		for (const f of fakes.splice(0)) f.dispose();
		_resetCallSessionForTests();
		_resetAppModalStackForTests();
		_resetVoiceForTests();
		setCryptoDialogOpen(false);
	});

	it("renders nothing when no session is published", () => {
		render(() => <FullCallOverlay />);
		expect(screen.queryByRole("region")).toBeNull();
	});

	it("renders the region with an aria-label derived from the room name", () => {
		const fake = track(makeFakeCallSession({ roomName: "Standup" }));
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		expect(
			screen.queryByRole("region", { name: "Native call in Standup" }),
		).toBeTruthy();
	});

	it("close button calls session.requestClose", () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const closeBtn = screen.getByRole("button", { name: "Close call" });
		closeBtn.click();
		expect(fake.requestClose).toHaveBeenCalledTimes(1);
	});

	it("close button is aria-disabled while leaving", () => {
		const fake = track(makeFakeCallSession());
		fake.setLeaving(true);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const closeBtn = screen.getByRole("button", { name: "Close call" });
		expect(closeBtn.getAttribute("aria-disabled")).toBe("true");
		closeBtn.click();
		expect(fake.requestClose).not.toHaveBeenCalled();
	});

	it("Escape inside the region calls requestClose", () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const region = screen.getByRole("region", {
			name: /Native call/,
		});
		const evt = new KeyboardEvent("keydown", {
			key: "Escape",
			bubbles: true,
			cancelable: true,
		});
		region.dispatchEvent(evt);
		expect(fake.requestClose).toHaveBeenCalledTimes(1);
	});

	it("Escape is suppressed when an app modal is open", () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		pushAppModal();
		const region = screen.getByRole("region", { name: /Native call/ });
		region.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(fake.requestClose).not.toHaveBeenCalled();
	});

	it("Escape is suppressed when a crypto dialog is open", () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		setCryptoDialogOpen(true);
		const region = screen.getByRole("region", { name: /Native call/ });
		region.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(fake.requestClose).not.toHaveBeenCalled();
	});

	it("non-Escape keys do not call requestClose", () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const region = screen.getByRole("region", { name: /Native call/ });
		region.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(fake.requestClose).not.toHaveBeenCalled();
	});

	it("region is inert when an app modal is open", async () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		pushAppModal();
		await flush();
		const region = screen.getByRole("region", { name: /Native call/ });
		expect((region as HTMLElement & { inert?: boolean }).inert).toBe(true);
	});

	it("region is inert when a crypto dialog is open", async () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		setCryptoDialogOpen(true);
		await flush();
		const region = screen.getByRole("region", { name: /Native call/ });
		expect((region as HTMLElement & { inert?: boolean }).inert).toBe(true);
	});

	it("shows Join call button when not joined and disabled while bridgeInitializing", async () => {
		const fake = track(makeFakeCallSession());
		fake.setBridgeInitializing(true);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const btn = screen.getByRole("button", { name: "Preparing…" });
		expect((btn as HTMLButtonElement).disabled).toBe(true);
		btn.click();
		expect(fake.requestJoin).not.toHaveBeenCalled();

		fake.setBridgeInitializing(false);
		await flush();
		const join = screen.getByRole("button", { name: "Join call" });
		expect((join as HTMLButtonElement).disabled).toBe(false);
		join.click();
		expect(fake.requestJoin).toHaveBeenCalledTimes(1);
	});

	it("Join button is disabled when rtc.canJoin is false and surfaces joinBlockReason", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcCanJoin(false);
		fake.setRtcJoinBlockReason("Encryption not ready");
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const join = screen.getByRole("button", { name: "Join call" });
		expect((join as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("Encryption not ready")).toBeTruthy();
	});

	it("shows Leave call button when joined and calls requestLeave on click", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const leave = screen.getByRole("button", { name: "Leave call" });
		leave.click();
		expect(fake.requestLeave).toHaveBeenCalledTimes(1);
	});

	it("Leave button is disabled while leaving", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		fake.setLeaving(true);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const leave = screen.getByRole("button", { name: "Leave call" });
		expect((leave as HTMLButtonElement).disabled).toBe(true);
	});

	it("mute toggle reflects userWantsMic and toggles on click when joined", () => {
		setUserWantsMic(true);
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const mute = screen.getByRole("button", { name: "Mute microphone" });
		mute.click();
		expect(userWantsMic()).toBe(false);
	});

	it("camera button calls setLocalCamEnabled with the inverse of the current state", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		fake.setLivekitLocalCamEnabled(false);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const cam = screen.getByRole("button", { name: "Start camera" });
		cam.click();
		expect(fake.livekitSetLocalCamEnabled).toHaveBeenCalledWith(true);
	});

	it("surfaces the bridge-init error in an alert", () => {
		const fake = track(makeFakeCallSession());
		fake.setBridgeInitError(new Error("worker module load failed"));
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("worker module load failed");
	});

	it("surfaces a LiveKit error in an alert", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		fake.setLivekitError(new Error("transport closed"));
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		expect(
			screen
				.getAllByRole("alert")
				.some((el) => (el.textContent ?? "").includes("transport closed")),
		).toBe(true);
	});

	it("audio-blocked banner calls resumeAudio on click", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		fake.setLivekitAudioBlocked(true);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const enable = screen.getByRole("button", { name: "Enable audio" });
		enable.click();
		expect(fake.livekitResumeAudio).toHaveBeenCalledTimes(1);
	});

	it("status label reflects rtc.status transitions", async () => {
		const fake = track(makeFakeCallSession());
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const status = screen.getByTestId("rtc-status");
		expect(status.textContent).toBe("Not joined");
		fake.setRtcStatus("joining");
		await flush();
		expect(status.textContent).toBe("Joining…");
		fake.setRtcStatus("joined");
		await flush();
		expect(status.textContent).toBe("Joined");
		fake.setRtcStatus("leaving");
		await flush();
		expect(status.textContent).toBe("Leaving…");
		fake.setRtcStatus("error");
		fake.setRtcError(new Error("foci offline"));
		await flush();
		expect(status.textContent).toBe("Error: foci offline");
	});

	it("restores focus to the previous focus owner on cleanup", async () => {
		const prev = document.createElement("button");
		prev.textContent = "outside";
		document.body.appendChild(prev);
		prev.focus();
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		publishCallSession(fake.api);
		const result = render(() => <FullCallOverlay />);
		await flush();
		// Sanity check: the overlay's onMount microtask moved focus to the
		// in-overlay Leave button. Without this assertion the test could
		// pass even if the focus handoff regressed.
		expect(document.activeElement).not.toBe(prev);
		result.unmount();
		expect(document.activeElement).toBe(prev);
		document.body.removeChild(prev);
	});
});
