import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createStore } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SummariesStore } from "../../../client/summaries";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";
import { usePinnedEvents } from "./usePinnedEvents";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(cleanup);

describe("usePinnedEvents membership permission", () => {
	it("reacts to an optimistic leave despite stale SDK admin power", () => {
		const room = createMockRoom("!room:example.com");
		room.__setCanSendStateEvent("m.room.pinned_events", true);
		const client = createMockClient(new Map([["!room:example.com", room]]));
		const [summaryState, setSummaryState] = createStore({
			"!room:example.com": { membership: "join" },
		});
		const summaries = summaryState as unknown as SummariesStore;

		const Probe = () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!room:example.com",
			);
			return <span>{pins.canPin() ? "can pin" : "cannot pin"}</span>;
		};

		render(() => (
			<TestClientProvider client={client} summaries={summaries}>
				<Probe />
			</TestClientProvider>
		));

		expect(screen.getByText("can pin")).toBeTruthy();
		setSummaryState("!room:example.com", "membership", "leave");
		expect(screen.getByText("cannot pin")).toBeTruthy();
	});
});
