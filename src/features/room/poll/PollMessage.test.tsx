import { MemoryRouter, Route, useParams } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../../client/client";
import { ClientContext } from "../../../client/client";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import type { EventInfo } from "./eventBlock";
import { PollMessage } from "./PollMessage";
import type { PollSnapshot } from "./pollSnapshot";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(cleanup);

function snapshot(overrides?: Partial<PollSnapshot>): PollSnapshot {
	return {
		pollId: "$poll",
		question: "Best pizza?",
		kind: "disclosed",
		maxSelections: 1,
		answers: [
			{ id: "a", text: "Margherita" },
			{ id: "b", text: "Pepperoni" },
		],
		counts: { a: 2, b: 1 },
		totalVotes: 3,
		myAnswers: [],
		canVote: true,
		hasPendingVote: false,
		failedAnswers: null,
		isEnded: false,
		endPending: false,
		endFailed: false,
		canEnd: false,
		undecryptableCount: 0,
		loadingResults: false,
		...overrides,
	};
}

function setup(overrides?: Partial<PollSnapshot>) {
	const onVote = vi.fn();
	const onEndPoll = vi.fn();
	const { container } = render(() => (
		<PollMessage
			poll={snapshot(overrides)}
			onVote={onVote}
			onEndPoll={onEndPoll}
		/>
	));
	return { onVote, onEndPoll, container };
}

function optionButton(text: string): HTMLButtonElement {
	const label = screen.getByText(text);
	const button = label.closest("button");
	if (!button) throw new Error(`no option button for ${text}`);
	return button as HTMLButtonElement;
}

describe("PollMessage rendering", () => {
	it("renders the question, options, and live tallies for a disclosed poll", () => {
		setup();
		expect(screen.getByText("Best pizza?")).toBeTruthy();
		expect(screen.getByText("Margherita")).toBeTruthy();
		expect(screen.getByText("Pepperoni")).toBeTruthy();
		expect(screen.getByText("Live results")).toBeTruthy();
		expect(screen.getByText("2 · 67%")).toBeTruthy();
		expect(screen.getByText("1 · 33%")).toBeTruthy();
		expect(screen.getByText("3 votes")).toBeTruthy();
	});

	it("hides counts for an active undisclosed poll but keeps the bars' geometry", () => {
		const { container } = setup({ kind: "undisclosed" });
		expect(screen.getByText("Results hidden until the poll ends")).toBeTruthy();
		expect(screen.queryByText("2 · 67%")).toBeNull();
		// The track elements are still rendered (zero-width fill), so results
		// revealing later cannot shift layout.
		const fills = container.querySelectorAll("li .bg-accent");
		expect(fills.length).toBe(2);
		for (const fill of fills) {
			expect((fill as HTMLElement).style.width).toBe("0%");
		}
		expect(screen.getByText("3 votes")).toBeTruthy();
	});

	it("reveals counts and highlights winners when an undisclosed poll ends", () => {
		setup({ kind: "undisclosed", isEnded: true });
		expect(screen.getByText("Final results")).toBeTruthy();
		expect(screen.getByText("2 · 67%")).toBeTruthy();
		const winner = screen.getByText("Margherita");
		expect(winner.className).toContain("text-text-emphasis");
		const loser = screen.getByText("Pepperoni");
		expect(loser.className).not.toContain("text-text-emphasis");
	});

	it("does not highlight a winner while the poll is still open", () => {
		setup();
		expect(screen.getByText("Margherita").className).not.toContain(
			"text-text-emphasis",
		);
	});

	it("marks the local user's vote", () => {
		setup({ myAnswers: ["b"] });
		expect(screen.getByText("(your vote)")).toBeTruthy();
		expect(optionButton("Pepperoni").getAttribute("aria-checked")).toBe("true");
		expect(optionButton("Margherita").getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	it("exposes radio semantics for single-select and checkbox for multi", () => {
		const { container } = setup();
		expect(
			container
				.querySelector('ul[aria-label="Poll options"]')
				?.getAttribute("role"),
		).toBe("radiogroup");
		expect(optionButton("Margherita").getAttribute("role")).toBe("radio");
		cleanup();
		const { container: multi } = setup({ maxSelections: 2 });
		expect(
			multi
				.querySelector('ul[aria-label="Poll options"]')
				?.getAttribute("role"),
		).toBe("group");
		expect(optionButton("Margherita").getAttribute("role")).toBe("checkbox");
	});

	it("uses a roving tabindex in the single-select radiogroup", () => {
		setup({ myAnswers: ["b"] });
		expect(optionButton("Pepperoni").tabIndex).toBe(0);
		expect(optionButton("Margherita").tabIndex).toBe(-1);
	});

	it("moves focus (without voting) on arrow keys in single-select", () => {
		const { onVote } = setup();
		const first = optionButton("Margherita");
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(optionButton("Pepperoni"));
		fireEvent.keyDown(optionButton("Pepperoni"), { key: "ArrowDown" });
		// Wraps around.
		expect(document.activeElement).toBe(optionButton("Margherita"));
		expect(onVote).not.toHaveBeenCalled();
	});

	it("pluralizes the vote count", () => {
		setup({ counts: { a: 1, b: 0 }, totalVotes: 1 });
		expect(screen.getByText("1 vote")).toBeTruthy();
	});

	it("shows a loading state before results have been fetched", () => {
		setup({ counts: { a: 0, b: 0 }, totalVotes: 0, loadingResults: true });
		expect(screen.getByText("Loading results…")).toBeTruthy();
	});

	it("warns when some votes could not be decrypted", () => {
		setup({ undecryptableCount: 2 });
		const warning = screen.getByRole("status");
		expect(warning.textContent).toContain("2 votes couldn't be decrypted");
	});
});

describe("PollMessage voting", () => {
	it("casts a single-select vote on click", () => {
		const { onVote } = setup();
		fireEvent.click(optionButton("Margherita"));
		expect(onVote).toHaveBeenCalledExactlyOnceWith(["a"]);
	});

	it("changes a single-select vote by clicking another option", () => {
		const { onVote } = setup({ myAnswers: ["a"] });
		fireEvent.click(optionButton("Pepperoni"));
		expect(onVote).toHaveBeenCalledExactlyOnceWith(["b"]);
	});

	it("treats re-clicking the selected single-select option as a no-op", () => {
		const { onVote } = setup({ myAnswers: ["a"] });
		fireEvent.click(optionButton("Margherita"));
		expect(onVote).not.toHaveBeenCalled();
	});

	it("builds multi-select ballots by toggling options", () => {
		const { onVote } = setup({ maxSelections: 2, myAnswers: ["a"] });
		fireEvent.click(optionButton("Pepperoni"));
		expect(onVote).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
	});

	it("retracts by unchecking the last multi-select option", () => {
		const { onVote } = setup({ maxSelections: 2, myAnswers: ["a"] });
		fireEvent.click(optionButton("Margherita"));
		expect(onVote).toHaveBeenCalledExactlyOnceWith([]);
	});

	it("locks unchecked options at the selection cap but keeps checked ones clickable", () => {
		const { onVote } = setup({
			maxSelections: 2,
			myAnswers: ["a", "b"],
			answers: [
				{ id: "a", text: "Margherita" },
				{ id: "b", text: "Pepperoni" },
				{ id: "c", text: "Hawaiian" },
			],
			counts: { a: 1, b: 1, c: 0 },
		});
		// aria-disabled (not the disabled attribute) so the option stays in
		// the tab order and perceivable; clicks are guarded instead.
		const locked = optionButton("Hawaiian");
		expect(locked.getAttribute("aria-disabled")).toBe("true");
		expect(locked.tabIndex).toBe(0);
		fireEvent.click(locked);
		expect(onVote).not.toHaveBeenCalled();
		fireEvent.click(optionButton("Pepperoni"));
		expect(onVote).toHaveBeenCalledExactlyOnceWith(["a"]);
	});

	it("shows the multi-select hint", () => {
		setup({ maxSelections: 2 });
		expect(screen.getByText("· Choose up to 2")).toBeTruthy();
	});

	it("disables voting once the poll has ended", () => {
		const { onVote } = setup({ isEnded: true });
		expect(optionButton("Margherita").getAttribute("aria-disabled")).toBe(
			"true",
		);
		fireEvent.click(optionButton("Margherita"));
		expect(onVote).not.toHaveBeenCalled();
	});

	it("disables voting while the poll is being ended", () => {
		setup({ canEnd: true, endPending: true });
		expect(optionButton("Margherita").getAttribute("aria-disabled")).toBe(
			"true",
		);
	});

	it("disables voting on provisional snapshots without a live SDK model", () => {
		// canVote=false: a pending local-echo poll (or one still decrypting)
		// has nothing to send a vote to yet - clicks must not be silently
		// dropped by the watcher.
		const { onVote } = setup({ canVote: false });
		expect(optionButton("Margherita").getAttribute("aria-disabled")).toBe(
			"true",
		);
		fireEvent.click(optionButton("Margherita"));
		expect(onVote).not.toHaveBeenCalled();
	});

	it("surfaces a failed vote with a Retry that resubmits the same ballot", () => {
		const { onVote } = setup({ failedAnswers: ["b"] });
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Couldn't record your vote");
		fireEvent.click(screen.getByText("Retry"));
		expect(onVote).toHaveBeenCalledExactlyOnceWith(["b"]);
	});
});

describe("PollMessage ending", () => {
	it("hides the End control from non-creators and on ended polls", () => {
		setup();
		expect(screen.queryByText("End poll")).toBeNull();
		cleanup();
		setup({ canEnd: true, isEnded: true });
		expect(screen.queryByText("End poll")).toBeNull();
	});

	it("requires a confirm step and then calls onEndPoll", () => {
		const { onEndPoll } = setup({ canEnd: true });
		fireEvent.click(screen.getByText("End poll"));
		expect(onEndPoll).not.toHaveBeenCalled();
		expect(screen.getByText("End poll? Voting will stop.")).toBeTruthy();
		fireEvent.click(screen.getByText("Confirm"));
		expect(onEndPoll).toHaveBeenCalledOnce();
	});

	it("cancels the confirm step without ending", () => {
		const { onEndPoll } = setup({ canEnd: true });
		fireEvent.click(screen.getByText("End poll"));
		fireEvent.click(screen.getByText("Cancel"));
		expect(onEndPoll).not.toHaveBeenCalled();
		expect(screen.getByText("End poll")).toBeTruthy();
	});

	it("keeps keyboard focus in the flow across the confirm swap", async () => {
		setup({ canEnd: true });
		const endButton = screen.getByText("End poll");
		endButton.focus();
		fireEvent.click(endButton);
		await Promise.resolve();
		// The clicked button unmounted; focus must land on Confirm, not
		// fall back to <body>.
		expect(document.activeElement).toBe(screen.getByText("Confirm"));
		fireEvent.click(screen.getByText("Cancel"));
		await Promise.resolve();
		expect(document.activeElement).toBe(screen.getByText("End poll"));
	});

	it("shows the Ending state while the close is in flight", () => {
		setup({ canEnd: true, endPending: true });
		expect(screen.getByText("Ending…")).toBeTruthy();
		expect(screen.queryByText("End poll")).toBeNull();
	});

	it("keeps undisclosed results hidden while the end is only pending", () => {
		setup({ kind: "undisclosed", canEnd: true, endPending: true });
		expect(screen.queryByText("2 · 67%")).toBeNull();
	});

	it("surfaces a failed end with a Retry", () => {
		const { onEndPoll } = setup({ canEnd: true, endFailed: true });
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Couldn't end the poll");
		fireEvent.click(screen.getByText("Retry"));
		expect(onEndPoll).toHaveBeenCalledOnce();
	});
});

describe("PollMessage event card (#418)", () => {
	function eventInfo(overrides?: Partial<EventInfo>): EventInfo {
		return {
			title: "Launch Party",
			startTs: Date.now() + 3 * 86_400_000, // in 3 days
			endTs: null,
			roomId: null,
			image: null,
			...overrides,
		};
	}

	function setupEvent(
		event: EventInfo | null,
		opts?: {
			roomName?: string;
			snapshot?: Partial<PollSnapshot>;
			tweakClient?: (client: ReturnType<typeof createMockClient>) => void;
		},
	) {
		const ROOM_ID = "!venue:test";
		const room = createMockRoom(ROOM_ID, [], [], {
			name: opts?.roomName ?? "The Venue",
		});
		const rooms = new Map([[ROOM_ID, room]]);
		const client = createMockClient(rooms);
		opts?.tweakClient?.(client);
		const [syncState] = createSignal<AppSyncState>("live");
		const [cryptoState] = createSignal<CryptoState>("ready");
		// useNavigate needs an actual matched Route, not just a router.
		const Subject = () => (
			<ClientContext.Provider
				value={{
					client: client as unknown as MatrixClient,
					syncState,
					cryptoState,
					summaries: {} as never,
					cryptoStatus: {
						crossSigningReady: () => true,
						thisDeviceVerified: () => true,
						backupVersion: () => null,
						backupTrusted: () => true,
						secretStorageReady: () => true,
						refresh: async () => {},
					},
					requestRecoveryKey: async () => null,
					setRecoveryKeyResolver: () => {},
					clearSecretStorageCache: () => {},
					optimisticallyMarkJoined: () => {},
					optimisticallyMarkLeft: () => {},
				}}
			>
				<PollMessage
					poll={snapshot({ event, ...opts?.snapshot })}
					onVote={() => {}}
					onEndPoll={() => {}}
				/>
			</ClientContext.Provider>
		);
		return render(() => (
			<MemoryRouter>
				<Route path="/" component={Subject} />
				{/* Marker for pill-navigation assertions: /home/:roomId is the
				    canonical room path (there is no /room route). The router does
				    NOT decode params (the app decodes at consumption, cf.
				    useDecodedParams), so decode here to prove the id round-trips
				    through encodeURIComponent. */}
				<Route
					path="/home/:roomId"
					component={() => (
						<div>
							navigated-home {decodeURIComponent(useParams().roomId ?? "")}
						</div>
					)}
				/>
			</MemoryRouter>
		));
	}

	it("renders the title, viewer-local time, and a relative line", () => {
		setupEvent(eventInfo());
		expect(screen.getByText("Launch Party")).toBeTruthy();
		// Assert against the runner's own locale data (the cascade can
		// truncate 3 days to 2 with render latency) so the test is stable
		// under non-English locales.
		const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
		const expected = [rtf.format(3, "day"), rtf.format(2, "day")];
		expect(expected.some((text) => screen.queryByText(text) !== null)).toBe(
			true,
		);
	});

	it("renders no event chrome for a plain poll (no block)", () => {
		setupEvent(null);
		expect(screen.queryByText("Launch Party")).toBeNull();
		// The vote UI itself is unaffected.
		expect(screen.getByText("Best pizza?")).toBeTruthy();
	});

	it("shows the target room as a pill with its name", () => {
		setupEvent(eventInfo({ roomId: "!venue:test" }));
		expect(screen.getByText("The Venue")).toBeTruthy();
	});

	it("the room pill navigates to the canonical /home/:roomId path", async () => {
		setupEvent(eventInfo({ roomId: "!venue:test" }));
		fireEvent.click(screen.getByText("The Venue"));
		// The /home/:roomId marker route only renders after a successful
		// navigation - a broken path (e.g. the nonexistent /room) would
		// leave the poll on screen. Router navigation is async, hence
		// findByText rather than getByText. The marker echoes the decoded
		// param, proving the id round-trips through encodeURIComponent.
		expect(await screen.findByText("navigated-home !venue:test")).toBeTruthy();
	});

	it("falls back to the room id for a whitespace-only room name", () => {
		setupEvent(eventInfo({ roomId: "!venue:test" }), { roomName: "   " });
		// The trimmed name is empty, so the pill shows the room id itself
		// rather than a blank label.
		expect(screen.getByText("!venue:test")).toBeTruthy();
	});

	it("reserves the cover image's layout box while it loads", () => {
		setupEvent(
			eventInfo({
				image: {
					url: "mxc://server/cover",
					file: null,
					info: { w: 800, h: 400, mimetype: "image/png", size: 1234 },
				},
			}),
		);
		// 800x400: the 160px height cap binds first (scale 0.4) -> 320x160.
		const img = screen.getByAltText("Launch Party") as HTMLImageElement;
		expect(img.style.width).toBe("320px");
		expect(img.style.height).toBe("160px");
	});

	it("renders nothing (no broken chrome) when the image has no usable source", () => {
		setupEvent(
			eventInfo({
				image: {
					url: "mxc://server/cover",
					file: null,
					info: { w: 800, h: 400, mimetype: "image/png", size: 1234 },
				},
			}),
			{
				// A validated EventImage always carries url or file, but the
				// client can still fail to resolve it (mxcUrlToHttp rejects)
				// - the card must not render broken chrome.
				tweakClient: (client) => {
					client.mxcUrlToHttp = () => "";
				},
			},
		);
		// The card header still renders; the image chrome is absent.
		expect(screen.getByText("Launch Party")).toBeTruthy();
		expect(screen.queryByAltText("Launch Party")).toBeNull();
		expect(screen.queryByText("Loading…")).toBeNull();
	});
});
