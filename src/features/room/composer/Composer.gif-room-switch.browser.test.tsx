/**
 * Covers the GIF send path (onGifSelect) AND the composer's cross-room isolation
 * under Layout's keyed <Show> remount (issues #310, #382).
 *
 * The original #310 test simulated an *in-place* roomId change to exercise a
 * per-path room guard. #382 removed those guards because Layout renders the room
 * subtree under a keyed <Show>, so a room switch REMOUNTS the composer and an
 * in-place roomId change never happens. This test therefore renders Composer
 * under that SAME keyed <Show> and asserts the two things that matter now:
 *   1. a picked GIF is sent to the room it was picked in, with the right content;
 *   2. an in-flight GIF send that resolves AFTER a room switch (i.e. after the
 *      composer remounted for the new room) cannot fire the new room's onSent.
 *
 * Runs in browser mode because it drives the real GIF picker UI.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import { clearNotices, notices } from "../../../stores/notices";
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

afterEach(() => {
	cleanup();
	clearNotices();
});

describe("Composer GIF send under the keyed-<Show> remount (#310, #382)", () => {
	it("sends a picked GIF to the room it was picked in, with GIF content", async () => {
		const client = makeClient();
		client.sendMessage = vi.fn(async () => ({
			event_id: "$sent",
		})) as unknown as typeof client.sendMessage;

		const [roomId] = createSignal(ROOM_A);
		const { findByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Show when={roomId()} keyed>
					{(rid) => <Composer roomId={rid} packs={[]} />}
				</Show>
			</TestClientProvider>
		));

		(await findByLabelText("Open GIF picker")).click();
		(await findByLabelText("party parrot")).click();

		// m.text with the GIF url + intrinsic dimensions (the info block receivers
		// use to reserve layout), sent to the room it was picked in, no thread.
		expect(client.sendMessage).toHaveBeenCalledTimes(1);
		expect(client.sendMessage).toHaveBeenCalledWith(
			ROOM_A,
			null,
			expect.objectContaining({
				msgtype: "m.text",
				body: GIF.url,
				info: expect.objectContaining({
					w: GIF.width,
					h: GIF.height,
					mimetype: "image/gif",
				}),
			}),
		);
	});

	it("does not fire the new room's onSent when a GIF send resolves after a room switch", async () => {
		const client = makeClient();

		// Hold the send in flight so it resolves AFTER the room switch remounts.
		let resolveSend: (v: { event_id: string }) => void = () => {};
		client.sendMessage = vi.fn(
			() =>
				new Promise<{ event_id: string }>((res) => {
					resolveSend = res;
				}),
		) as unknown as typeof client.sendMessage;

		// Distinct onSent per room, resolved through the keyed render prop, so we
		// can tell whose send-completion fired.
		const onSentA = vi.fn();
		const onSentB = vi.fn();
		const [roomId, setRoomId] = createSignal(ROOM_A);

		const { findByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Show when={roomId()} keyed>
					{(rid) => (
						<Composer
							roomId={rid}
							packs={[]}
							onSent={rid === ROOM_A ? onSentA : onSentB}
						/>
					)}
				</Show>
			</TestClientProvider>
		));

		// Pick the GIF in ROOM_A → its send is in flight, pinned to ROOM_A.
		(await findByLabelText("Open GIF picker")).click();
		(await findByLabelText("party parrot")).click();
		expect(client.sendMessage).toHaveBeenCalledWith(
			ROOM_A,
			null,
			expect.anything(),
		);

		// Switch to ROOM_B: the keyed <Show> REMOUNTS the composer, so ROOM_B gets
		// a fresh instance while the ROOM_A send is still pending.
		setRoomId(ROOM_B);
		await tick();

		// The ROOM_A send now resolves.
		resolveSend({ event_id: "$sent" });
		await tick();

		// Its completion fires ROOM_A's own onSent (on the disposed instance) and
		// cannot reach ROOM_B's fresh composer.
		expect(onSentA).toHaveBeenCalledTimes(1);
		expect(onSentB).not.toHaveBeenCalled();
	});

	it("surfaces an app-level notice when a GIF send FAILS after a room switch", async () => {
		const client = makeClient();

		// Hold the send, then reject it after the room switch.
		let rejectSend: (reason: Error) => void = () => {};
		client.sendMessage = vi.fn(
			() =>
				new Promise<{ event_id: string }>((_res, rej) => {
					rejectSend = rej;
				}),
		) as unknown as typeof client.sendMessage;

		const [roomId, setRoomId] = createSignal(ROOM_A);
		const { findByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Show when={roomId()} keyed>
					{(rid) => <Composer roomId={rid} packs={[]} />}
				</Show>
			</TestClientProvider>
		));

		(await findByLabelText("Open GIF picker")).click();
		(await findByLabelText("party parrot")).click();

		// Leave ROOM_A: its composer is disposed while the send is still pending.
		setRoomId(ROOM_B);
		await tick();

		// The ROOM_A send now fails. The inline error would land on the disposed
		// composer, so a notice must surface instead - not a silent loss (#381).
		rejectSend(new Error("network"));
		await tick();

		expect(notices()).toHaveLength(1);
		expect(notices()[0].message).toContain("GIF");
		expect(notices()[0].tone).toBe("error");
	});

	it("does NOT push a notice when a GIF send fails while still on the room", async () => {
		const client = makeClient();
		client.sendMessage = vi.fn(() =>
			Promise.reject(new Error("network")),
		) as unknown as typeof client.sendMessage;

		const [roomId] = createSignal(ROOM_A);
		const { findByLabelText } = render(() => (
			<TestClientProvider client={client}>
				<Show when={roomId()} keyed>
					{(rid) => <Composer roomId={rid} packs={[]} />}
				</Show>
			</TestClientProvider>
		));

		(await findByLabelText("Open GIF picker")).click();
		(await findByLabelText("party parrot")).click();
		await tick();

		// Still on ROOM_A, so the inline composer error is visible - no app-level
		// toast (that would be a redundant double surface). Guards the
		// `if (disposed)` escalation gate.
		expect(notices()).toHaveLength(0);
	});
});
