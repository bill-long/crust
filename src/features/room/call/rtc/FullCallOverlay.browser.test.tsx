import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../../styles/global.css";
import { updateSetting } from "../../../../stores/settings";
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

afterEach(() => {
	cleanup();
	updateSetting("rtcShowCallStats", false);
	_resetCallSessionForTests();
});

it("expands a shared screen inside the window and returns to the call with Escape", async () => {
	const fake = makeFakeCallSession();
	const share = makeFakeStatsTrack({
		statsEntries: [inboundVideo(), vp9Codec],
	});
	const { attach, detach } = share;
	updateSetting("rtcShowCallStats", true);
	const cameraAttach = vi.fn();
	const cameraDetach = vi.fn();
	try {
		fake.setLivekitParticipants([
			participant({ identity: "a", displayName: "Amon" }),
		]);
		fake.setLivekitVideoTracks(
			new Map([
				[
					"a",
					{
						track: { attach: cameraAttach, detach: cameraDetach } as never,
						sid: "camera",
					},
				],
			]),
		);
		publishCallSession(fake.api);
		render(() => <FullCallOverlay />);
		expect(cameraAttach).toHaveBeenCalledTimes(1);
		fake.setLivekitParticipants([]);
		fake.setLivekitScreenShareTracks(
			new Map([["a", { track: share.track, sid: "ss-1" }]]),
		);
		const grid = screen.getByTestId("participant-grid");
		expect(grid.children).toHaveLength(1);
		expect(screen.getByText("Participants (1)")).toBeTruthy();
		fake.setLivekitParticipants([
			participant({ identity: "a", displayName: "Amon" }),
		]);
		expect(cameraDetach).toHaveBeenCalledTimes(1);
		const expand = screen.getByRole("button", { name: "Expand Amon’s screen" });
		const closeCall = screen.getByRole("button", { name: "Close call" });
		await expect
			.poll(() => screen.queryAllByTestId("track-stats").length)
			.toBe(1);
		await userEvent.click(expand);
		const viewer = screen.getByRole("dialog", { name: "Amon’s screen" });
		await expect
			.poll(() => screen.queryAllByTestId("track-stats").length)
			.toBe(1);
		expect(viewer.querySelector('[data-testid="track-stats"]')).not.toBeNull();
		expect(viewer.getBoundingClientRect().width).toBeCloseTo(
			window.innerWidth,
			0,
		);
		expect(viewer.getBoundingClientRect().height).toBeCloseTo(
			window.innerHeight,
			0,
		);
		expect(viewer.querySelector("video")?.muted).toBe(true);
		fake.setLivekitParticipants([
			participant({ identity: "a", displayName: "Amon", isSpeaking: true }),
		]);
		expect(screen.getByRole("dialog", { name: "Amon’s screen" })).toBe(viewer);
		fake.setLivekitScreenShareTracks(
			new Map([["a", { track: { attach, detach } as never, sid: "ss-2" }]]),
		);
		expect(screen.getByRole("dialog", { name: "Amon’s screen" })).toBe(viewer);
		expect(attach).toHaveBeenCalledTimes(4);
		fake.setLivekitScreenShareTracks(
			new Map(fake.api.livekit.screenShareTracks()),
		);
		expect(screen.getByRole("dialog", { name: "Amon’s screen" })).toBe(viewer);
		expect(attach).toHaveBeenCalledTimes(4);
		await userEvent.keyboard("{Escape}");
		await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
		await expect.poll(() => document.activeElement).toBe(expand);
		expect(fake.requestClose).not.toHaveBeenCalled();
		await userEvent.click(expand);
		fake.setLivekitScreenShareTracks(new Map());
		await expect.poll(() => screen.queryByRole("dialog")).toBeNull();
		await expect.poll(() => document.activeElement).toBe(closeCall);
		expect(attach).toHaveBeenCalledTimes(5);
		expect(detach).toHaveBeenCalledTimes(5);
		expect(grid.children).toHaveLength(1);
		expect(cameraAttach).toHaveBeenCalledTimes(2);
	} finally {
		cleanup();
		fake.dispose();
	}
});
