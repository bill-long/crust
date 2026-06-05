import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type RoomSummary,
	type SummariesStore,
} from "../../client/summaries";
import { createMockClient } from "../../test/mockClient";
import { SpacesSidebar } from "./SpacesSidebar";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
const paramsState: { spaceId?: string } = {};
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useParams: () => paramsState,
}));

function makeSpaceSummary(roomId: string, name: string): RoomSummary {
	return {
		roomId,
		name,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: true,
		kind: "text",
		callActive: false,
		children: [],
	};
}

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
	seed: RoomSummary[];
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const store = createSummariesStore(props.client as unknown as MatrixClient);
	for (const s of props.seed) {
		store.setSummaries(s.roomId, s);
	}
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
					backupTrusted: () => true,
					secretStorageReady: () => true,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	paramsState.spaceId = undefined;
});

function setupWithSpace(): {
	client: ReturnType<typeof createMockClient>;
	onOpenSpaceSettings: ReturnType<typeof vi.fn>;
} {
	const client = createMockClient();
	const onOpenSpaceSettings = vi.fn();
	render(() => (
		<Wrapper
			client={client}
			seed={[makeSpaceSummary("!alpha:example.com", "Alpha")]}
		>
			<SpacesSidebar onOpenSpaceSettings={onOpenSpaceSettings} />
		</Wrapper>
	));
	return { client, onOpenSpaceSettings };
}

describe("SpacesSidebar gear button", () => {
	it("renders a settings button for each space that calls onOpenSpaceSettings", () => {
		const { onOpenSpaceSettings } = setupWithSpace();
		const gear = screen.getByRole("button", { name: /Settings for Alpha/ });
		expect(gear).toBeTruthy();
		fireEvent.click(gear);
		expect(onOpenSpaceSettings).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("clicking the avatar still navigates and does NOT open settings", () => {
		const { onOpenSpaceSettings } = setupWithSpace();
		fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!alpha:example.com")}`,
		);
		expect(onOpenSpaceSettings).not.toHaveBeenCalled();
	});

	it("omits the gear button when no onOpenSpaceSettings prop is provided", () => {
		const client = createMockClient();
		render(() => (
			<Wrapper
				client={client}
				seed={[makeSpaceSummary("!beta:example.com", "Beta")]}
			>
				<SpacesSidebar />
			</Wrapper>
		));
		expect(
			screen.queryByRole("button", { name: /Settings for Beta/ }),
		).toBeNull();
	});
});
