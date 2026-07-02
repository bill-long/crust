import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		isEnded: false,
		undecryptableCount: 0,
		loadingResults: false,
		...overrides,
	};
}

describe("PollMessage", () => {
	it("renders the question, options, and live tallies for a disclosed poll", () => {
		render(() => <PollMessage poll={snapshot()} />);
		expect(screen.getByText("Best pizza?")).toBeTruthy();
		expect(screen.getByText("Margherita")).toBeTruthy();
		expect(screen.getByText("Pepperoni")).toBeTruthy();
		expect(screen.getByText("Live results")).toBeTruthy();
		expect(screen.getByText("2 · 67%")).toBeTruthy();
		expect(screen.getByText("1 · 33%")).toBeTruthy();
		expect(screen.getByText("3 votes")).toBeTruthy();
	});

	it("hides counts for an active undisclosed poll but keeps the bars' geometry", () => {
		const { container } = render(() => (
			<PollMessage poll={snapshot({ kind: "undisclosed" })} />
		));
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
		render(() => (
			<PollMessage poll={snapshot({ kind: "undisclosed", isEnded: true })} />
		));
		expect(screen.getByText("Final results")).toBeTruthy();
		expect(screen.getByText("2 · 67%")).toBeTruthy();
		const winner = screen.getByText("Margherita");
		expect(winner.className).toContain("text-text-emphasis");
		const loser = screen.getByText("Pepperoni");
		expect(loser.className).not.toContain("text-text-emphasis");
	});

	it("does not highlight a winner while the poll is still open", () => {
		render(() => <PollMessage poll={snapshot()} />);
		expect(screen.getByText("Margherita").className).not.toContain(
			"text-text-emphasis",
		);
	});

	it("marks the local user's vote", () => {
		render(() => <PollMessage poll={snapshot({ myAnswers: ["b"] })} />);
		expect(screen.getByText("(your vote)")).toBeTruthy();
	});

	it("pluralizes the vote count", () => {
		render(() => (
			<PollMessage poll={snapshot({ counts: { a: 1, b: 0 }, totalVotes: 1 })} />
		));
		expect(screen.getByText("1 vote")).toBeTruthy();
	});

	it("shows a loading state before results have been fetched", () => {
		render(() => (
			<PollMessage
				poll={snapshot({
					counts: { a: 0, b: 0 },
					totalVotes: 0,
					loadingResults: true,
				})}
			/>
		));
		expect(screen.getByText("Loading results…")).toBeTruthy();
	});

	it("warns when some votes could not be decrypted", () => {
		render(() => <PollMessage poll={snapshot({ undecryptableCount: 2 })} />);
		const warning = screen.getByRole("status");
		expect(warning.textContent).toContain("2 votes couldn't be decrypted");
	});
});
