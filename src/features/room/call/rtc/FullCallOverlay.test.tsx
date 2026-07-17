import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCryptoDialogOpen } from "../../../../stores/cryptoActions";
import {
	_resetAppModalStackForTests,
	pushAppModal,
} from "../../../../stores/modalStack";
import { updateSetting } from "../../../../stores/settings";
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
import { makeFakeCallSession, participant } from "./fakeCallSession.test-utils";
import {
	inboundVideo,
	makeFakeStatsTrack,
	vp9Codec,
} from "./trackStats.test-utils";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

// The stats badge's first poll is phase-scheduled via setTimeout(0), so
// letting it land needs a macrotask turn, not just microtasks.
const flushStatsTick = (): Promise<void> =>
	new Promise((r) => setTimeout(r, 0));

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
		updateSetting("rtcShowCallStats", false);
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

	it("screen-share button calls setLocalScreenShareEnabled with the inverse of the current state", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		fake.setLivekitLocalScreenShareEnabled(false);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		const share = screen.getByRole("button", { name: "Share screen" });
		share.click();
		expect(fake.livekitSetLocalScreenShareEnabled).toHaveBeenCalledWith(true);
	});

	it("hides the screen-share button when getDisplayMedia is unsupported", () => {
		const fake = track(makeFakeCallSession());
		fake.setRtcStatus("joined");
		fake.setLivekitStatus("connected");
		// screenShareSupported is a static field on the fake's LivekitRoomApi;
		// override it to model a browser without display capture.
		fake.api.livekit.screenShareSupported = false;
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		expect(screen.queryByRole("button", { name: "Share screen" })).toBeNull();
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

	it("renders a participant avatar image when avatarUrl is set and the initial otherwise", () => {
		const fake = track(makeFakeCallSession());
		fake.setLivekitParticipants([
			participant({
				identity: "a",
				displayName: "Amon",
				avatarUrl: "https://media.example.com/amon",
				avatarUrlLarge: "https://media.example.com/amon",
				isLocal: true,
			}),
			participant({ identity: "b", displayName: "Bea" }),
		]);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);

		const grid = screen.getByTestId("participant-grid");
		const avatars = grid.querySelectorAll("img");
		expect(avatars.length).toBe(1);
		expect(avatars[0].getAttribute("src")).toContain("amon");
		// The avatar-less participant falls back to the uppercase initial.
		expect(screen.getByText("B")).toBeTruthy();
	});

	it("renders a labelled screen-share tile that attaches the shared track", () => {
		const attach = vi.fn();
		const detach = vi.fn();
		const fake = track(makeFakeCallSession());
		fake.setLivekitParticipants([
			participant({ identity: "a", displayName: "Amon" }),
		]);
		fake.setLivekitScreenShareTracks(
			new Map([["a", { track: { attach, detach } as never, sid: "ss-1" }]]),
		);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);

		const grid = screen.getByTestId("participant-grid");
		// One participant tile + one screen-share tile, each with a <video>.
		expect(grid.querySelectorAll("video").length).toBe(2);
		// The screen-share tile attaches the shared track to its element.
		expect(attach).toHaveBeenCalledTimes(1);
		// The tile is labelled with the sharer's name and carries an indicator.
		expect(grid.textContent).toContain("Amon");
		expect(grid.textContent).toContain("screen");
		expect(screen.getByLabelText("Screen share")).toBeTruthy();
	});

	it("does not render a screen-share tile when no screen share is active", () => {
		const fake = track(makeFakeCallSession());
		fake.setLivekitParticipants([
			participant({ identity: "a", displayName: "Amon" }),
		]);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		expect(screen.queryByLabelText("Screen share")).toBeNull();
	});

	// A stats-capable fake video track (shared builder so the track surface
	// TrackStatsOverlay reads is defined once). `as never` matches the
	// file's existing minimal-track idiom.
	const makeStatsTrack = (width: number, height: number) =>
		makeFakeStatsTrack({
			statsEntries: [
				inboundVideo({ frameWidth: width, frameHeight: height }),
				vp9Codec,
			],
		}).track as never;

	const remoteAmon = participant({ identity: "a", displayName: "Amon" });
	const localSelf = participant({
		identity: "me",
		displayName: "Me",
		isLocal: true,
	});

	it("shows receive stats on remote tiles and send stats on local tiles when rtcShowCallStats is on", async () => {
		updateSetting("rtcShowCallStats", true);
		const fake = track(makeFakeCallSession());
		fake.setLivekitParticipants([localSelf, remoteAmon]);
		fake.setLivekitVideoTracks(
			new Map([
				["a", { track: makeStatsTrack(1280, 720), sid: "v-a" }],
				["me", { track: makeStatsTrack(640, 480), sid: "v-me" }],
			]),
		);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		// Let the overlay's phase-scheduled first stats tick land.
		await flushStatsTick();
		const badges = screen.getAllByTestId("track-stats");
		expect(badges.length).toBe(2);
		const texts = badges.map((b) => b.textContent ?? "");
		// The remote tile's receive badge decodes the fixture's inbound
		// frames; the local tile's send badge reads outbound-rtp, which the
		// receive-shaped fixture doesn't carry - honest "no frames sent".
		expect(texts.some((x) => x.includes("1280x720"))).toBe(true);
		expect(texts.some((x) => x.includes("no frames sent"))).toBe(true);
	});

	it("shows receive stats on a remote share and send stats on the local user's own share", async () => {
		updateSetting("rtcShowCallStats", true);
		const fake = track(makeFakeCallSession());
		fake.setLivekitParticipants([localSelf, remoteAmon]);
		fake.setLivekitScreenShareTracks(
			new Map([
				["a", { track: makeStatsTrack(2560, 1440), sid: "ss-a" }],
				["me", { track: makeStatsTrack(1920, 1080), sid: "ss-me" }],
			]),
		);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		await flushStatsTick();
		const badges = screen.getAllByTestId("track-stats");
		expect(badges.length).toBe(2);
		const texts = badges.map((b) => b.textContent ?? "");
		expect(texts.some((x) => x.includes("2560x1440"))).toBe(true);
		expect(texts.some((x) => x.includes("no frames sent"))).toBe(true);
	});

	it("keeps the stats readout when the participant snapshot object is replaced (tile remount)", async () => {
		updateSetting("rtcShowCallStats", true);
		const fake = track(makeFakeCallSession());
		fake.setLivekitParticipants([remoteAmon]);
		fake.setLivekitVideoTracks(
			new Map([["a", { track: makeStatsTrack(1280, 720), sid: "v-a" }]]),
		);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		await flushStatsTick();
		expect(screen.getByTestId("track-stats").textContent).toContain("1280x720");

		// A speaking flip produces a NEW participant object; the
		// reference-keyed <For> rebuilds the tile. What only this suite can
		// verify is that the rebuilt tile hands the badge the SAME track
		// object, so the badge is present immediately (text-level
		// persistence is locked by the TrackStatsOverlay unit suite).
		fake.setLivekitParticipants([
			participant({ identity: "a", displayName: "Amon", isSpeaking: true }),
		]);
		await flush();
		expect(screen.getByTestId("track-stats")).toBeTruthy();
	});

	it("fails closed: no stats overlay on a share whose participant record is missing", async () => {
		updateSetting("rtcShowCallStats", true);
		const fake = track(makeFakeCallSession());
		// Teardown ordering can empty the participant snapshot before the share
		// map clears; an unresolved sharer must not be treated as remote.
		fake.setLivekitParticipants([]);
		fake.setLivekitScreenShareTracks(
			new Map([["me", { track: makeStatsTrack(1920, 1080), sid: "ss-me" }]]),
		);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		await flushStatsTick();
		expect(screen.queryByTestId("track-stats")).toBeNull();
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
