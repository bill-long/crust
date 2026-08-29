import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uia401 } from "../../test/uiaFixtures";
import {
	SignOutSessionsDialog,
	type SignOutTarget,
} from "./SignOutSessionsDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const deleteDevice = vi.fn();
const deleteMultipleDevices = vi.fn();

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getDeviceId: () => "THISDEV",
			deleteDevice: (deviceId: string, auth?: unknown) =>
				deleteDevice(deviceId, auth),
			deleteMultipleDevices: (deviceIds: string[], auth?: unknown) =>
				deleteMultipleDevices(deviceIds, auth),
			getAuthMetadata: async () => {
				throw new Error("no oauth metadata");
			},
		},
	}),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const PASSWORD_FLOW = [["m.login.password"]];

const ONE_DEVICE: SignOutTarget = {
	kind: "device",
	deviceId: "OTHERDEV",
	deviceName: "Old laptop",
};

function renderDialog(
	overrides: Partial<{
		target: SignOutTarget;
		portalUrl: string | null;
		viaPortal: boolean;
		onClose: () => void;
		onSignedOut: () => void;
	}> = {},
) {
	const onClose = overrides.onClose ?? vi.fn();
	const onSignedOut = overrides.onSignedOut ?? vi.fn();
	render(() => (
		<SignOutSessionsDialog
			target={overrides.target ?? ONE_DEVICE}
			portalUrl={overrides.portalUrl ?? null}
			viaPortal={overrides.viaPortal ?? false}
			onClose={onClose}
			onSignedOut={onSignedOut}
		/>
	));
	return { onClose, onSignedOut };
}

/** Answer the password prompt the flow is waiting on. */
async function submitPassword(password: string): Promise<void> {
	const input = await screen.findByLabelText("Password");
	fireEvent.input(input, { target: { value: password } });
	fireEvent.submit(input.closest("form") as HTMLFormElement);
}

describe("SignOutSessionsDialog", () => {
	it("names the device in the confirmation", () => {
		renderDialog();
		expect(screen.getByText("Old laptop")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
	});

	it("sends nothing until the sign-out is confirmed", () => {
		renderDialog();
		expect(deleteDevice).not.toHaveBeenCalled();
	});

	it("completes the password challenge, then reports the revoke", async () => {
		deleteDevice
			.mockRejectedValueOnce(uia401("sess", PASSWORD_FLOW))
			.mockResolvedValueOnce({});
		const { onClose, onSignedOut } = renderDialog();

		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		await submitPassword("hunter2");

		await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(deleteDevice).toHaveBeenLastCalledWith(
			"OTHERDEV",
			expect.objectContaining({ password: "hunter2", session: "sess" }),
		);
	});

	it("re-prompts on a wrong password rather than failing the sign-out", async () => {
		deleteDevice
			.mockRejectedValueOnce(uia401("sess", PASSWORD_FLOW))
			.mockRejectedValueOnce(uia401("sess-2", PASSWORD_FLOW))
			.mockResolvedValueOnce({});
		const { onSignedOut } = renderDialog();

		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		await submitPassword("wrong");
		await screen.findByText("Incorrect password. Try again.");
		await submitPassword("right");

		await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
	});

	it("closes rather than stepping back when the password prompt is cancelled", async () => {
		// A cancelled flow is aborted for good (only preflight clears that,
		// and this operation has none), so stepping back to the confirmation
		// would leave a Sign out button that can never prompt again.
		deleteDevice.mockRejectedValue(uia401("sess", PASSWORD_FLOW));
		const { onClose, onSignedOut } = renderDialog();

		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		await screen.findByLabelText("Password");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		// A cancel is not a failure, and nothing was revoked.
		expect(screen.queryByText("Sign-out failed")).toBeNull();
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it("reports a server failure and offers the portal as a way through", async () => {
		deleteDevice.mockRejectedValue(
			Object.assign(new Error("Server is unavailable"), { httpStatus: 500 }),
		);
		const { onSignedOut } = renderDialog({
			portalUrl: "https://hs.example/account?action=org.matrix.device_delete",
		});

		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

		await screen.findByText("Sign-out failed");
		expect(onSignedOut).not.toHaveBeenCalled();
		const link = screen.getByRole("link", { name: "Open account settings" });
		expect(link.getAttribute("href")).toBe(
			"https://hs.example/account?action=org.matrix.device_delete",
		);
	});

	describe("a session managed at the provider", () => {
		it("links to this device's own removal page and never attempts the delete", async () => {
			renderDialog({
				viaPortal: true,
				portalUrl:
					"https://hs.example/account?action=org.matrix.device_delete&device_id=OTHERDEV",
			});

			const link = screen.getByRole("link", {
				name: "Open account settings",
			});
			expect(link.getAttribute("href")).toBe(
				"https://hs.example/account?action=org.matrix.device_delete&device_id=OTHERDEV",
			);
			// The in-app confirm is not offered at all - classic UIA cannot
			// complete for these sessions (cinnyapp/cinny#2376).
			expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
			expect(deleteDevice).not.toHaveBeenCalled();
		});

		it("says so plainly when the server advertises no portal", () => {
			renderDialog({ viaPortal: true, portalUrl: null });
			expect(screen.queryByRole("link")).toBeNull();
			expect(
				screen.getByText(/did not provide a link to its account settings/),
			).toBeTruthy();
			expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
		});

		it("does not claim there is no portal while the lookup is in flight", () => {
			// undefined means "still looking"; saying "your homeserver did not
			// provide a link" here is false on the one path where that link is
			// the user's only affordance.
			render(() => (
				<SignOutSessionsDialog
					target={ONE_DEVICE}
					viaPortal={true}
					onClose={vi.fn()}
					onSignedOut={vi.fn()}
				/>
			));
			expect(
				screen.queryByText(/did not provide a link to its account settings/),
			).toBeNull();
			expect(screen.getByText(/Finding your account settings/)).toBeTruthy();
		});
	});

	describe("signing every other session out", () => {
		const OTHERS: SignOutTarget = {
			kind: "others",
			deviceIds: ["DEV_A", "DEV_B", "DEV_C"],
		};

		it("counts the sessions it is about to revoke", () => {
			renderDialog({ target: OTHERS });
			expect(screen.getByText("Sign out all other sessions?")).toBeTruthy();
			expect(screen.getByText("3 other sessions")).toBeTruthy();
			// The one thing the user must not misread: this session survives.
			expect(screen.getByText(/This session stays signed in/)).toBeTruthy();
		});

		it("says what signing back in costs", () => {
			renderDialog({ target: OTHERS });
			expect(screen.getByText(/start out unverified/)).toBeTruthy();
		});

		it("keeps the count singular for one other session", () => {
			renderDialog({
				target: { kind: "others", deviceIds: ["DEV_A"] },
			});
			expect(screen.getByText("1 other session")).toBeTruthy();
		});

		it("revokes them in ONE request, not one per device", async () => {
			deleteMultipleDevices
				.mockRejectedValueOnce(uia401("sess", PASSWORD_FLOW))
				.mockResolvedValueOnce({});
			const { onClose, onSignedOut } = renderDialog({ target: OTHERS });

			fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
			await submitPassword("hunter2");

			await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(deleteDevice).not.toHaveBeenCalled();
			expect(deleteMultipleDevices).toHaveBeenCalledTimes(2);
			expect(deleteMultipleDevices).toHaveBeenLastCalledWith(
				["DEV_A", "DEV_B", "DEV_C"],
				expect.objectContaining({ password: "hunter2", session: "sess" }),
			);
		});

		it("reports a bulk failure in the plural", async () => {
			deleteMultipleDevices.mockRejectedValue(
				Object.assign(new TypeError("Failed to fetch"), {}),
			);
			renderDialog({ target: OTHERS });

			fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

			await screen.findByText("Sign-out failed");
			expect(
				screen.getByText("Couldn't sign those sessions out."),
			).toBeTruthy();
		});

		it("sends a provider-managed session to the portal's session list", () => {
			renderDialog({
				target: OTHERS,
				viaPortal: true,
				portalUrl: "https://hs.example/account?action=org.matrix.devices_list",
			});
			expect(
				screen
					.getByRole("link", { name: "Open account settings" })
					.getAttribute("href"),
			).toBe("https://hs.example/account?action=org.matrix.devices_list");
			expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
			expect(deleteMultipleDevices).not.toHaveBeenCalled();
		});
	});

	describe("keyboard containment", () => {
		// The dialog renders inside SettingsOverlay, which closes itself on a
		// delegated Escape - so Escape here must not reach it.
		it("keeps Escape from reaching an enclosing overlay", async () => {
			const onClose = vi.fn();
			const outerEscape = vi.fn();
			// Mirrors SettingsOverlay: an ancestor with role="dialog" whose
			// Escape handler is a JSX (delegated) onKeyDown. The delegation
			// matters - Solid walks up from the target and honours
			// cancelBubble, which a natively attached listener would not
			// model, because that one fires during the real bubble phase
			// before Solid's document-level handler runs at all.
			render(() => (
				<div
					role="dialog"
					aria-label="Settings"
					tabIndex={-1}
					onKeyDown={outerEscape}
				>
					<SignOutSessionsDialog
						target={ONE_DEVICE}
						portalUrl={null}
						onClose={onClose}
						onSignedOut={vi.fn()}
					/>
				</div>
			));

			fireEvent.keyDown(
				screen.getByRole("dialog", { name: "Sign out session" }),
				{ key: "Escape" },
			);

			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(outerEscape).not.toHaveBeenCalled();
		});

		it("keeps Escape from reaching an enclosing overlay for the bulk dialog", async () => {
			// Same guard, second dialog shape: the label differs, so a test
			// pinned to the device wording would not cover it.
			const onClose = vi.fn();
			const outerEscape = vi.fn();
			render(() => (
				<div
					role="dialog"
					aria-label="Settings"
					tabIndex={-1}
					onKeyDown={outerEscape}
				>
					<SignOutSessionsDialog
						target={{ kind: "others", deviceIds: ["DEV_A"] }}
						portalUrl={null}
						onClose={onClose}
						onSignedOut={vi.fn()}
					/>
				</div>
			));

			fireEvent.keyDown(
				screen.getByRole("dialog", { name: "Sign out other sessions" }),
				{ key: "Escape" },
			);

			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(outerEscape).not.toHaveBeenCalled();
		});
	});
});
