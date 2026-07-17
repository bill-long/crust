import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSetting } from "../../../../stores/settings";
import {
	_resetVoiceForTests,
	setMicHotkeyHeld,
	setUserWantsMic,
} from "../../../../stores/voice";
import { CallOverlayPanel } from "./CallOverlayPanel";
import {
	_resetCallSessionForTests,
	publishCallSession,
} from "./callSessionStore";
import { makeFakeCallSession, participant } from "./fakeCallSession.test-utils";
import type { RtcParticipant } from "./useLivekitRoom";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

function rowFor(name: string): HTMLElement {
	const label = screen.getByText(name);
	const li = label.closest("li");
	if (!li) throw new Error(`No row for ${name}`);
	return li as HTMLElement;
}

describe("CallOverlayPanel", () => {
	const fakes: Array<{ dispose: () => void }> = [];

	afterEach(() => {
		cleanup();
		for (const f of fakes.splice(0)) f.dispose();
		_resetCallSessionForTests();
		_resetVoiceForTests();
		updateSetting("micMode", "voice-activity");
		updateSetting("micHotkey", null);
	});

	function setup(parts: readonly RtcParticipant[]) {
		const fake = makeFakeCallSession({ roomName: "General" });
		fakes.push(fake);
		fake.setLivekitParticipants(parts);
		publishCallSession(fake.api);
		render(() => <CallOverlayPanel />);
		return fake;
	}

	it("renders a row per participant", () => {
		setup([
			participant({ identity: "a", displayName: "Alice" }),
			participant({ identity: "b", displayName: "Bob" }),
		]);
		expect(screen.getByText("Alice")).toBeTruthy();
		expect(screen.getByText("Bob")).toBeTruthy();
	});

	it("shows an empty state when nobody has joined", () => {
		setup([]);
		expect(screen.getByText(/nobody has joined/i)).toBeTruthy();
	});

	it("exposes a non-color speaking cue for assistive tech", () => {
		setup([
			participant({ identity: "a", displayName: "Talker", isSpeaking: true }),
			participant({ identity: "b", displayName: "Quiet", isSpeaking: false }),
		]);
		expect(within(rowFor("Talker")).getByText(/speaking/i)).toBeTruthy();
		expect(within(rowFor("Quiet")).queryByText(/speaking/i)).toBeNull();
	});

	it("does not mark a muted local participant as speaking", () => {
		setUserWantsMic(false);
		setup([
			participant({
				identity: "me",
				displayName: "Me",
				isLocal: true,
				isSpeaking: true,
			}),
		]);
		// Muted overrides speaking, so no speaking cue should appear.
		expect(within(rowFor("Me")).queryByText(/speaking/i)).toBeNull();
	});

	it("does not show the local mic as muted while transmitting", () => {
		setUserWantsMic(true);
		setup([participant({ identity: "me", displayName: "Me", isLocal: true })]);
		const row = rowFor("Me");
		expect(within(row).queryByLabelText("Microphone muted")).toBeNull();
	});

	it("crosses out the local mic when manually muted (voice store)", () => {
		setUserWantsMic(false);
		setup([
			participant({
				identity: "me",
				displayName: "Me",
				isLocal: true,
				// LiveKit publication still reports unmuted; the panel must use
				// the voice store for the local row, not this field.
				isMuted: false,
			}),
		]);
		const row = rowFor("Me");
		expect(within(row).getByLabelText("Microphone muted")).toBeTruthy();
	});

	it("crosses out the local mic on push-to-mute while the key is held", () => {
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", {
			ctrl: false,
			shift: false,
			alt: false,
			meta: false,
			code: "KeyM",
		});
		setUserWantsMic(true);
		setMicHotkeyHeld(true); // user is pushing the mute key

		setup([participant({ identity: "me", displayName: "Me", isLocal: true })]);
		expect(
			within(rowFor("Me")).getByLabelText("Microphone muted"),
		).toBeTruthy();

		// Releasing the key un-mutes the indicator.
		setMicHotkeyHeld(false);
		expect(
			within(rowFor("Me")).queryByLabelText("Microphone muted"),
		).toBeNull();
	});

	it("uses the LiveKit isMuted field for remote participants", () => {
		setup([
			participant({
				identity: "r1",
				displayName: "MutedRemote",
				isMuted: true,
			}),
			participant({
				identity: "r2",
				displayName: "LiveRemote",
				isMuted: false,
			}),
		]);
		expect(
			within(rowFor("MutedRemote")).getByLabelText("Microphone muted"),
		).toBeTruthy();
		expect(
			within(rowFor("LiveRemote")).queryByLabelText("Microphone muted"),
		).toBeNull();
	});

	it("hangs up via the direct-leave path (no confirm dialog)", () => {
		const fake = setup([
			participant({ identity: "me", displayName: "Me", isLocal: true }),
		]);
		screen.getByLabelText("Disconnect from call").click();
		expect(fake.requestLeave).toHaveBeenCalledTimes(1);
		expect(fake.requestClose).not.toHaveBeenCalled();
	});
});
