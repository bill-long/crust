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
import { createMockClient, createMockRoom } from "../../test/mockClient";
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
				optimisticallyMarkLeft: vi.fn(),
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

function setupWithLeave(): {
	client: ReturnType<typeof createMockClient>;
	onOpenSpaceSettings: ReturnType<typeof vi.fn>;
	onLeaveSpace: ReturnType<typeof vi.fn>;
} {
	const client = createMockClient();
	const onOpenSpaceSettings = vi.fn();
	const onLeaveSpace = vi.fn();
	render(() => (
		<Wrapper
			client={client}
			seed={[makeSpaceSummary("!alpha:example.com", "Alpha")]}
		>
			<SpacesSidebar
				onOpenSpaceSettings={onOpenSpaceSettings}
				onLeaveSpace={onLeaveSpace}
			/>
		</Wrapper>
	));
	return { client, onOpenSpaceSettings, onLeaveSpace };
}

function setupWithInvite(opts?: {
	canInvite?: boolean;
	includeSettings?: boolean;
	includeLeave?: boolean;
}): {
	client: ReturnType<typeof createMockClient>;
	onInviteSpace: ReturnType<typeof vi.fn>;
	onOpenSpaceSettings: ReturnType<typeof vi.fn>;
	onLeaveSpace: ReturnType<typeof vi.fn>;
} {
	const room = createMockRoom("!alpha:example.com", [], [], { name: "Alpha" });
	if (opts?.canInvite === false) room.__setCanInvite(false);
	const client = createMockClient(new Map([["!alpha:example.com", room]]));
	const onInviteSpace = vi.fn();
	const onOpenSpaceSettings = vi.fn();
	const onLeaveSpace = vi.fn();
	render(() => (
		<Wrapper
			client={client}
			seed={[makeSpaceSummary("!alpha:example.com", "Alpha")]}
		>
			<SpacesSidebar
				onInviteSpace={onInviteSpace}
				onOpenSpaceSettings={
					opts?.includeSettings === false ? undefined : onOpenSpaceSettings
				}
				onLeaveSpace={opts?.includeLeave === false ? undefined : onLeaveSpace}
			/>
		</Wrapper>
	));
	return { client, onInviteSpace, onOpenSpaceSettings, onLeaveSpace };
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

describe("SpacesSidebar right-click context menu", () => {
	function openContextMenu(): void {
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
	}

	it("opens a context menu with Space settings and Leave space items", async () => {
		setupWithLeave();
		openContextMenu();
		expect(await screen.findByText("Space settings")).toBeTruthy();
		expect(screen.getByText("Leave space")).toBeTruthy();
	});

	it("selecting Leave space calls onLeaveSpace", async () => {
		const { onLeaveSpace } = setupWithLeave();
		openContextMenu();
		await screen.findByText("Leave space");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Leave space") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onLeaveSpace).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("selecting Space settings calls onOpenSpaceSettings", async () => {
		const { onOpenSpaceSettings } = setupWithLeave();
		openContextMenu();
		await screen.findByText("Space settings");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Space settings") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onOpenSpaceSettings).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("omits the Leave space item when no onLeaveSpace prop is provided", async () => {
		setupWithSpace();
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
		expect(await screen.findByText("Space settings")).toBeTruthy();
		expect(screen.queryByText("Leave space")).toBeNull();
	});

	it("does not mount a ContextMenu when neither handler is provided (avoids empty popover)", () => {
		const client = createMockClient();
		render(() => (
			<Wrapper
				client={client}
				seed={[makeSpaceSummary("!gamma:example.com", "Gamma")]}
			>
				<SpacesSidebar />
			</Wrapper>
		));
		const avatar = screen.getByRole("button", { name: "Gamma" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
		// The popover itself should not mount (not just be empty).
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByRole("menuitem")).toBeNull();
		expect(screen.queryByText("Space settings")).toBeNull();
		expect(screen.queryByText("Leave space")).toBeNull();
	});
});

describe("SpacesSidebar invite", () => {
	function openContextMenu(): void {
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
	}

	it("renders Invite people item when onInviteSpace is provided and user can invite", async () => {
		setupWithInvite();
		openContextMenu();
		expect(await screen.findByText("Invite people")).toBeTruthy();
	});

	it("selecting Invite people calls onInviteSpace with the space id", async () => {
		const { onInviteSpace } = setupWithInvite();
		openContextMenu();
		await screen.findByText("Invite people");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Invite people") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onInviteSpace).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("hides Invite people when the user lacks invite permission", async () => {
		setupWithInvite({ canInvite: false });
		openContextMenu();
		// Space settings still mounts → wait for the menu, then assert absence.
		await screen.findByText("Space settings");
		expect(screen.queryByText("Invite people")).toBeNull();
	});

	it("mounts a ContextMenu with only Invite people when other handlers are absent", async () => {
		const { onInviteSpace } = setupWithInvite({
			includeSettings: false,
			includeLeave: false,
		});
		openContextMenu();
		expect(await screen.findByText("Invite people")).toBeTruthy();
		expect(screen.queryByText("Space settings")).toBeNull();
		expect(screen.queryByText("Leave space")).toBeNull();
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Invite people") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onInviteSpace).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("does not mount a ContextMenu when canInvite is false and no other handlers are provided", () => {
		setupWithInvite({
			canInvite: false,
			includeSettings: false,
			includeLeave: false,
		});
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByText("Invite people")).toBeNull();
	});
});
