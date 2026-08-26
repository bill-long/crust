import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import {
	_resetJoinDialogForTests,
	joinDialogRequest,
	requestJoinDialog,
} from "../../stores/joinDialog";
import { createMockClient } from "../../test/mockClient";
import { JoinRoomDialogHost } from "./JoinRoomDialogHost";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
}));

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const { summaries } = createSummariesStore(
		props.client as unknown as MatrixClient,
	);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: summaries as unknown as SummariesStore,
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
				optimisticallySetMarkedUnread: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	_resetJoinDialogForTests();
});

function setup() {
	const client = createMockClient();
	render(() => (
		<Wrapper client={client}>
			<JoinRoomDialogHost client={client as unknown as MatrixClient} />
		</Wrapper>
	));
	return { client };
}

function addressInput(): HTMLInputElement {
	return screen.getByLabelText(/^Room address or link$/i) as HTMLInputElement;
}

function cancelButton(): HTMLElement {
	return screen.getByRole("button", { name: /^Cancel$/i });
}

describe("JoinRoomDialogHost", () => {
	it("stays closed without a request", () => {
		setup();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens the dialog prefilled when a permalink request arrives", async () => {
		setup();
		requestJoinDialog({
			idOrAlias: "!linked:example.org",
			viaServers: ["s1.org"],
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
		expect(addressInput().value).toBe("!linked:example.org s1.org");
	});

	it("opens blank on a manual (no-prefill) request", async () => {
		setup();
		requestJoinDialog();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
		expect(addressInput().value).toBe("");
	});

	it("clears the store request when the dialog closes", async () => {
		setup();
		requestJoinDialog({ idOrAlias: "#linked:example.org", viaServers: [] });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
		fireEvent.click(cancelButton());
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(joinDialogRequest()).toBeNull();
	});

	it("does not carry a stale prefill into the next open", async () => {
		setup();
		// Permalink open -> close -> later manual open must start empty, not
		// re-prefill the old address.
		requestJoinDialog({ idOrAlias: "#linked:example.org", viaServers: [] });
		await waitFor(() =>
			expect(addressInput().value).toBe("#linked:example.org"),
		);
		fireEvent.click(cancelButton());
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		requestJoinDialog();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
		expect(addressInput().value).toBe("");
	});
});
