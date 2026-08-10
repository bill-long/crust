import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type JSX, type ParentComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import {
	_resetIgnoredUsersForTests,
	initIgnoredUsers,
} from "../../stores/ignoredUsers";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import { MemberList } from "./MemberList";

// virtua's Virtualizer requires real layout measurements (ResizeObserver +
// non-zero element sizes) that jsdom doesn't provide. Substitute the same
// transparent renderer the MembersTab tests use so every row mounts.
vi.mock("virtua/solid", async () => {
	const solid = await import("solid-js");
	return {
		Virtualizer: <T,>(props: {
			data: T[];
			children: (item: T, index: number) => unknown;
		}) =>
			solid.createComponent(solid.For, {
				get each() {
					return props.data;
				},
				children: (item: T) => props.children(item, 0) as JSX.Element,
			}),
	};
});

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

vi.mock("@solidjs/router", () => ({
	useNavigate: () => vi.fn(),
}));

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const store = createSummariesStore(props.client as unknown as MatrixClient);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: store.summaries as unknown as SummariesStore,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
					backupOnServer: () => false,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					crossSigningStatus: () => undefined,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined: vi.fn(),
				optimisticallyMarkKnocked: vi.fn(),
				optimisticallyMarkLeft: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function setup(ignored: string[] = []) {
	const room = createMockRoom(
		"!room:example.com",
		[],
		[
			{ userId: "@test:example.com", name: "Me", powerLevel: 0 },
			{ userId: "@alice:example.com", name: "Alice", powerLevel: 0 },
		],
	);
	const client = createMockClient(new Map([["!room:example.com", room]]));
	client.getIgnoredUsers.mockReturnValue(ignored);
	initIgnoredUsers(client as never);
	render(() => (
		<Wrapper client={client}>
			<MemberList roomId="!room:example.com" />
		</Wrapper>
	));
	return { client };
}

async function openMenu(displayName: string): Promise<void> {
	const trigger = screen.getByLabelText(`Actions for ${displayName}`);
	fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
	fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
	fireEvent.click(trigger);
	fireEvent.keyDown(trigger, { key: "Enter" });
	await waitFor(() => expect(screen.getByText("Message")).toBeTruthy());
}

async function clickItem(label: string): Promise<void> {
	const item = screen.getByText(label);
	fireEvent.pointerMove(item, { pointerType: "mouse" });
	fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
	fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
	fireEvent.click(item);
	fireEvent.keyDown(item, { key: "Enter" });
}

afterEach(() => {
	cleanup();
	_resetIgnoredUsersForTests();
});

beforeEach(() => {
	// Kobalte's scroll-prevention cleanup calls window.scrollTo, which
	// jsdom doesn't implement; stub it to keep the test output clean.
	window.scrollTo = vi.fn();
});

describe("MemberList block/unblock", () => {
	it("offers Block for a non-ignored member and persists the ignore", async () => {
		const { client } = setup();
		await waitFor(() =>
			expect(screen.getByLabelText("Actions for Alice")).toBeTruthy(),
		);
		await openMenu("Alice");
		await clickItem("Block");
		await waitFor(() =>
			expect(client.setIgnoredUsers).toHaveBeenCalledWith([
				"@alice:example.com",
			]),
		);
	});

	it("offers Unblock for an ignored member and removes the ignore", async () => {
		const { client } = setup(["@alice:example.com"]);
		await waitFor(() =>
			expect(screen.getByLabelText("Actions for Alice")).toBeTruthy(),
		);
		await openMenu("Alice");
		await clickItem("Unblock");
		await waitFor(() =>
			expect(client.setIgnoredUsers).toHaveBeenCalledWith([]),
		);
	});

	it("does not offer block actions for your own row", async () => {
		setup();
		await waitFor(() => expect(screen.getByText("Me")).toBeTruthy());
		expect(screen.queryByLabelText("Actions for Me")).toBeNull();
	});
});
