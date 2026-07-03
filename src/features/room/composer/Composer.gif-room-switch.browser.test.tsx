/**
 * Regression test for #310: `onGifSelect`'s completion-time writes must be
 * gated on still being on the room the send STARTED in - the same contract
 * `send()` and the voice path enforce. A GIF send that resolves after the
 * user switched rooms must not clear the newly-selected room's reply state
 * (`onSent`) or otherwise mutate its composer.
 *
 * Runs in browser mode because it drives the real GIF picker UI.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";

// GifPicker reads gif config (trendingOnOpen, provider) from useConfig; the
// real ConfigProvider fetches config.json over the network, so stub it.
vi.mock("../../../app/ConfigProvider", () => ({
	useConfig: () => ({
		gif: {
			provider: "giphy",
			apiKey: "key",
			trendingOnOpen: true,
			maxRating: "g",
		},
	}),
}));

// Enable the GIF button and fetch trending on open, so the picker populates
// without typing a query.
vi.mock("../../gif/gifConfig", () => ({
	useGifConfig: () => ({
		available: () => true,
		provider: () => "giphy",
		apiKey: () => "key",
		trendingOnOpen: () => true,
		maxRating: () => "g",
		autoDownload: () => false,
	}),
}));

const GIF = {
	id: "g1",
	title: "party parrot",
	url: "https://cdn.example.com/parrot.gif",
	previewUrl: "https://cdn.example.com/parrot-preview.gif",
	stillUrl: "https://cdn.example.com/parrot-still.png",
	width: 200,
	height: 200,
};

// Return one trending GIF without a network call.
vi.mock("../../gif/provider", () => ({
	createGifProvider: () => ({
		trending: async () => ({ items: [GIF], hasMore: false, nextOffset: 0 }),
		search: async () => ({ items: [GIF], hasMore: false, nextOffset: 0 }),
		attribution: {
			name: "Giphy",
			logoUrl: "",
			url: "",
			searchPlaceholder: "Search Giphy",
		},
	}),
}));

const { Composer } = await import("./Composer");

const ROOM_A = "!a:example.com";
const ROOM_B = "!b:example.com";

function makeClient() {
	const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
	const member = [{ userId: "@test:example.com", name: "Test" }];
	rooms.set(ROOM_A, createMockRoom(ROOM_A, [], member));
	rooms.set(ROOM_B, createMockRoom(ROOM_B, [], member));
	return createMockClient(rooms);
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => cleanup());

describe("Composer GIF send room-switch guard (#310)", () => {
	it("does not clear the new room's reply state when a GIF send resolves after a room switch", async () => {
		const client = makeClient();

		// Hold the send in flight so it can resolve AFTER the room switch.
		let resolveSend: (v: { event_id: string }) => void = () => {};
		client.sendMessage = vi.fn(
			() =>
				new Promise<{ event_id: string }>((res) => {
					resolveSend = res;
				}),
		) as typeof client.sendMessage;

		const onSent = vi.fn();
		const [roomId, setRoomId] = createSignal(ROOM_A);

		const { findByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Composer roomId={roomId()} packs={[]} onSent={onSent} />
			</TestClientProvider>
		));

		// Open the picker and pick the trending GIF → onGifSelect fires and the
		// send (pinned to ROOM_A) is now in flight.
		(await findByLabelText("Open GIF picker")).click();
		(await findByLabelText("party parrot")).click();
		// The GIF must be sent to the room it was picked in (ROOM_A), with no
		// thread. This pins the core contract so a future change that routed
		// the send to the switched-to room would fail here, not just on onSent.
		expect(client.sendMessage).toHaveBeenCalledTimes(1);
		expect(client.sendMessage).toHaveBeenCalledWith(
			ROOM_A,
			null,
			expect.objectContaining({ msgtype: "m.text", body: GIF.url }),
		);

		// User switches to ROOM_B while the ROOM_A send is still pending.
		setRoomId(ROOM_B);
		await tick();

		// The ROOM_A send now resolves - its completion writes must NOT touch
		// ROOM_B's composer.
		resolveSend({ event_id: "$sent" });
		await tick();

		expect(onSent).not.toHaveBeenCalled();
	});
});
