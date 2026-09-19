import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../../styles/global.css";
import { TestClientProvider } from "../../../test/TimelineHarness";
import { EVENT_ANSWERS, parseEventBlock } from "./eventBlock";
import { PollMessage } from "./PollMessage";
import type { PollSnapshot } from "./pollSnapshot";

afterEach(cleanup);

it("shows only viewer-local event time while preserving RSVP and plain poll headings", async () => {
	// An existing event created in Tokyo, viewed in the browser's own timezone.
	const startTs = Date.UTC(2026, 8, 20, 1);
	const question = "Eve Online - Sun, Sep 20, 10:00 AM GMT+9 in voice";
	const event = parseEventBlock({
		"pizza.strange.event": {
			title: "Eve Online",
			start_ts: startTs,
		},
	});
	const [poll, setPoll] = createSignal<PollSnapshot>({
		pollId: "$event",
		question,
		event,
		kind: "disclosed",
		maxSelections: 1,
		answers: EVENT_ANSWERS.map((text) => ({ id: text, text })),
		counts: {},
		voters: {},
		totalVotes: 0,
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
	});
	const onVote = vi.fn();
	const { container } = render(() => (
		<MemoryRouter>
			<Route
				path="/"
				component={() => (
					<TestClientProvider>
						<PollMessage poll={poll()} onVote={onVote} onEndPoll={() => {}} />
					</TestClientProvider>
				)}
			/>
		</MemoryRouter>
	));
	const localTime = new Date(startTs).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	expect(screen.getByText("Eve Online")).toBeTruthy();
	expect(container.textContent).toContain(localTime);
	expect(screen.queryByText(question)).toBeNull();
	expect(screen.getByText("Live results")).toBeTruthy();
	await userEvent.click(screen.getByRole("radio", { name: /Going/ }));
	expect(onVote).toHaveBeenCalledWith(["Going"]);

	setPoll((previous) => ({ ...previous, event: null }));
	expect(screen.getByText(question)).toBeTruthy();
	expect(screen.queryByText("Eve Online")).toBeNull();
});
