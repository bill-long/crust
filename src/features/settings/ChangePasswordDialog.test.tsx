import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const changePassword = vi.fn();
vi.mock("../../client/accountSecurity", () => ({
	changePassword: (...args: unknown[]) => changePassword(...args),
}));

vi.mock("../../client/client", () => ({
	useClient: () => ({ client: { getUserId: () => "@test:example.com" } }),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function fill(opts: { current: string; next: string; confirm: string }): void {
	fireEvent.input(screen.getByLabelText("Current password"), {
		target: { value: opts.current },
	});
	fireEvent.input(screen.getByLabelText("New password"), {
		target: { value: opts.next },
	});
	fireEvent.input(screen.getByLabelText("Confirm new password"), {
		target: { value: opts.confirm },
	});
}

describe("ChangePasswordDialog", () => {
	it("rejects mismatched confirmation without a network call", async () => {
		render(() => <ChangePasswordDialog onClose={() => {}} />);
		fill({ current: "old", next: "new-1", confirm: "new-2" });
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("don't match"),
		);
		expect(changePassword).not.toHaveBeenCalled();
	});

	it("changes the password and reports the kept sessions", async () => {
		changePassword.mockResolvedValue(undefined);
		render(() => <ChangePasswordDialog onClose={() => {}} />);
		fill({ current: "old", next: "new-pw", confirm: "new-pw" });
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		await waitFor(() =>
			expect(screen.getByText("Password changed")).toBeTruthy(),
		);
		expect(changePassword).toHaveBeenCalledWith(expect.anything(), {
			currentPassword: "old",
			newPassword: "new-pw",
			logoutOtherDevices: false,
		});
		expect(
			screen.getByText("Your other sessions stay signed in."),
		).toBeTruthy();
	});

	it("passes the sign-out-others choice through", async () => {
		changePassword.mockResolvedValue(undefined);
		render(() => <ChangePasswordDialog onClose={() => {}} />);
		fill({ current: "old", next: "new-pw", confirm: "new-pw" });
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		await waitFor(() =>
			expect(screen.getByText("Password changed")).toBeTruthy(),
		);
		expect(changePassword).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ logoutOtherDevices: true }),
		);
		expect(
			screen.getByText("Your other sessions have been signed out."),
		).toBeTruthy();
	});

	it("surfaces a failure inline and returns to the form", async () => {
		changePassword.mockRejectedValue(new Error("Invalid password"));
		render(() => <ChangePasswordDialog onClose={() => {}} />);
		fill({ current: "wrong", next: "new-pw", confirm: "new-pw" });
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"Invalid password",
			),
		);
		// Back on the form, ready to retry.
		expect(screen.getByLabelText("Current password")).toBeTruthy();
	});

	it("reclaims focus for the overlay when the form unmounts for the done panel", async () => {
		changePassword.mockResolvedValue(undefined);
		render(() => <ChangePasswordDialog onClose={() => {}} />);
		fill({ current: "old", next: "new-pw", confirm: "new-pw" });
		// Focus lives inside the form; its unmount drops focus to the body,
		// which would kill overlay-scoped Escape/Tab without the reclaim.
		screen.getByLabelText("Current password").focus();
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));

		await waitFor(() =>
			expect(screen.getByText("Password changed")).toBeTruthy(),
		);
		const overlay = screen.getByRole("dialog", { name: "Change password" });
		await waitFor(() => expect(document.activeElement).toBe(overlay));
	});

	it("focuses the current-password input on open", async () => {
		render(() => <ChangePasswordDialog onClose={() => {}} />);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByLabelText("Current password"),
			),
		);
	});
});
