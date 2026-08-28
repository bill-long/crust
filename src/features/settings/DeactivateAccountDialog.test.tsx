import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeactivateAccountDialog } from "./DeactivateAccountDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const deactivateAccount = vi.fn();
vi.mock("../../client/accountSecurity", () => ({
	deactivateAccount: (...args: unknown[]) => deactivateAccount(...args),
}));

// Mutable so a test can simulate an unknown user ID.
const clientUserId: { value: string | null } = { value: "@test:example.com" };
vi.mock("../../client/client", () => ({
	useClient: () => ({ client: { getUserId: () => clientUserId.value } }),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	clientUserId.value = "@test:example.com";
});

const USER_ID = "@test:example.com";

function setup(onDeactivated: () => void = () => {}): void {
	render(() => (
		<DeactivateAccountDialog onClose={() => {}} onDeactivated={onDeactivated} />
	));
}

function submitButton(): HTMLButtonElement {
	return screen.getByRole("button", {
		name: "Deactivate forever",
	}) as HTMLButtonElement;
}

describe("DeactivateAccountDialog", () => {
	it("keeps the destructive button disabled until the user ID is typed exactly", () => {
		setup();
		expect(submitButton().disabled).toBe(true);

		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: "@test:example" },
		});
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "pw" },
		});
		expect(submitButton().disabled).toBe(true);

		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: USER_ID },
		});
		expect(submitButton().disabled).toBe(false);
	});

	it("fails closed when the user ID is unknown", () => {
		clientUserId.value = null;
		setup();
		// With userId "" the untouched confirm field matches it - the gate
		// must still refuse.
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "pw" },
		});
		expect(submitButton().disabled).toBe(true);
	});

	it("requires a password even with the ID confirmed", () => {
		setup();
		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: USER_ID },
		});
		expect(submitButton().disabled).toBe(true);
	});

	it("ignores an Enter-key submit while the confirmation is incomplete", async () => {
		// The button is disabled, but Enter in a field still fires the form's
		// submit - the ready() guard is what stops that path.
		setup();
		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: "@wrong:example.com" },
		});
		const password = screen.getByLabelText("Password");
		fireEvent.input(password, { target: { value: "pw" } });
		fireEvent.submit(password.closest("form") as HTMLFormElement);
		await Promise.resolve();
		expect(deactivateAccount).not.toHaveBeenCalled();
	});

	it("deactivates with the erase choice and hands off to the logout path", async () => {
		deactivateAccount.mockResolvedValue(undefined);
		const onDeactivated = vi.fn();
		setup(onDeactivated);

		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: USER_ID },
		});
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "pw" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(submitButton());

		await waitFor(() => expect(onDeactivated).toHaveBeenCalled());
		expect(deactivateAccount).toHaveBeenCalledWith(expect.anything(), {
			password: "pw",
			erase: true,
		});
	});

	it("surfaces a failure inline and does not sign out", async () => {
		deactivateAccount.mockRejectedValue(new Error("Invalid password"));
		const onDeactivated = vi.fn();
		setup(onDeactivated);

		fireEvent.input(screen.getByLabelText(/to confirm/), {
			target: { value: USER_ID },
		});
		fireEvent.input(screen.getByLabelText("Password"), {
			target: { value: "nope" },
		});
		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"Invalid password",
			),
		);
		expect(onDeactivated).not.toHaveBeenCalled();
	});
});
