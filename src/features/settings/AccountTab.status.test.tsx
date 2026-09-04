import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordSelfPresence, recordSelfStatusMsg } from "../../client/presence";
import { AccountTab } from "./AccountTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

vi.mock("../../stores/session", () => ({
	loadSession: () => ({
		accessToken: "t",
		userId: "@test:example.com",
		deviceId: "DEV",
		homeserverUrl: "https://hs.example",
	}),
}));

vi.mock("../../client/accountSecurity", () => ({
	fetchThreePids: async () => [],
	changePassword: vi.fn(),
	deactivateAccount: vi.fn(),
}));

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getUser: () => null,
			on: () => {},
			removeListener: () => {},
			getIgnoredUsers: () => [],
			getCapabilities: async () => ({}),
			getAuthMetadata: async () => {
				throw new Error("no delegated auth");
			},
		},
	}),
}));

const fetchStatusMessage = vi.fn(async (): Promise<string> => "");
const setStatusMessage = vi.fn(async (_raw: string): Promise<void> => {});
vi.mock("../../client/presencePublish", () => ({
	fetchStatusMessage: () => fetchStatusMessage(),
	setStatusMessage: (raw: string) => setStatusMessage(raw),
}));

const ME = "@test:example.com";

function setup() {
	render(() => <AccountTab onDeactivated={() => {}} />);
}

const editButton = (): HTMLButtonElement => {
	// The Profile section has two Edit buttons (display name first).
	const buttons = screen.getAllByRole("button", { name: "Edit" });
	return buttons[buttons.length - 1] as HTMLButtonElement;
};
const input = (): HTMLInputElement =>
	screen.getByLabelText("Status message") as HTMLInputElement;
const setInput = (value: string): void => {
	fireEvent.input(input(), { target: { value } });
};

beforeEach(() => {
	fetchStatusMessage.mockReset();
	fetchStatusMessage.mockResolvedValue("");
	setStatusMessage.mockReset();
	setStatusMessage.mockResolvedValue(undefined);
	recordSelfPresence(ME, true);
	recordSelfStatusMsg(ME, "");
});

afterEach(cleanup);

describe("AccountTab status message (#538)", () => {
	it("shows the store's rendering of our status, or a placeholder", () => {
		setup();
		expect(screen.getByText("No status set")).toBeTruthy();
		recordSelfStatusMsg(ME, "  on\n\nholiday  ");
		expect(screen.getByText("on holiday")).toBeTruthy();
	});

	it("prefills the editor from the raw server value, not the rendering", async () => {
		// The rendering collapses whitespace and cuts at the cap; saving it
		// back unedited would rewrite the real status (#538's round trip).
		// Runs of spaces the rendering collapses; the raw value keeps them.
		const raw = "  raw     value  ";
		fetchStatusMessage.mockResolvedValue(raw);
		recordSelfStatusMsg(ME, raw);
		setup();
		fireEvent.click(editButton());
		await waitFor(() => expect(input().value).toBe(raw));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(setStatusMessage).toHaveBeenCalledWith(raw));
	});

	it("counts the cap in code points, so 61 emoji are not over it", async () => {
		setup();
		fireEvent.click(editButton());
		await waitFor(() => expect(input().readOnly).toBe(false));
		setInput("\u{1F600}".repeat(61));
		expect(screen.getByText("61/120")).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
		setInput("\u{1F600}".repeat(121));
		expect(screen.getByText("121/120")).toBeTruthy();
		expect(input().getAttribute("aria-invalid")).toBe("true");
		expect(
			(screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.keyDown(input(), { key: "Enter" });
		await Promise.resolve();
		expect(setStatusMessage).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain("at most 120");
	});

	it("Clear sends an explicit empty status, whatever is typed", async () => {
		setup();
		fireEvent.click(editButton());
		await waitFor(() => expect(input().readOnly).toBe(false));
		setInput("keep me?");
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		await waitFor(() => expect(setStatusMessage).toHaveBeenLastCalledWith(""));
	});

	it("is focusable while the raw prefill is in flight", async () => {
		// readOnly, not disabled: a disabled control refuses focus, so the
		// editor would open with focus dropped on the body.
		let resolve: (v: string) => void = () => {};
		fetchStatusMessage.mockImplementationOnce(
			() => new Promise<string>((r) => (resolve = r)),
		);
		setup();
		fireEvent.click(editButton());
		expect(input().disabled).toBe(false);
		expect(input().readOnly).toBe(true);
		resolve("loaded");
		await waitFor(() => expect(input().readOnly).toBe(false));
		expect(input().value).toBe("loaded");
	});

	it("ignores Enter while the raw prefill is in flight", async () => {
		// The readOnly input is focused and still receives keydown; saving
		// the still-empty editor would clear the real status.
		let resolve: (v: string) => void = () => {};
		fetchStatusMessage.mockImplementationOnce(
			() => new Promise<string>((r) => (resolve = r)),
		);
		setup();
		fireEvent.click(editButton());
		fireEvent.keyDown(input(), { key: "Enter" });
		await Promise.resolve();
		expect(setStatusMessage).not.toHaveBeenCalled();
		resolve("kept");
		await waitFor(() => expect(input().value).toBe("kept"));
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(setStatusMessage).toHaveBeenCalledWith("kept"));
	});

	it("keeps Escape from reaching the settings overlay", async () => {
		// The overlay closes on an Escape its (Solid-delegated) root handler
		// sees; the editor must stop it there, like a parent handler here.
		const reached = vi.fn();
		render(() => (
			<div role="dialog" aria-label="Settings" onKeyDown={reached}>
				<AccountTab onDeactivated={() => {}} />
			</div>
		));
		fireEvent.click(editButton());
		await waitFor(() => expect(input().readOnly).toBe(false));
		fireEvent.keyDown(input(), { key: "Escape" });
		expect(reached).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Status message")).toBeNull();
	});

	it("treats Enter during IME composition as the candidate commit, not a save", async () => {
		setup();
		fireEvent.click(editButton());
		await waitFor(() => expect(input().readOnly).toBe(false));
		setInput("{6F22}");
		fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
		await Promise.resolve();
		expect(setStatusMessage).not.toHaveBeenCalled();
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() =>
			expect(setStatusMessage).toHaveBeenCalledWith("{6F22}"),
		);
	});

	it("closes the editor without a prefill it could not load", async () => {
		fetchStatusMessage.mockRejectedValue(new Error("presence off"));
		setup();
		fireEvent.click(editButton());
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("presence off"),
		);
		expect(screen.queryByLabelText("Status message")).toBeNull();
	});

	it("keeps the editor open with the error when the save fails", async () => {
		setStatusMessage.mockRejectedValue(new Error("M_LIMIT_EXCEEDED"));
		setup();
		fireEvent.click(editButton());
		await waitFor(() => expect(input().readOnly).toBe(false));
		setInput("busy");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"M_LIMIT_EXCEEDED",
			),
		);
		expect(input().value).toBe("busy");
	});

	it("does not let a slow prefill overwrite a newer edit session", async () => {
		let resolveFirst: (v: string) => void = () => {};
		fetchStatusMessage.mockImplementationOnce(
			() => new Promise<string>((r) => (resolveFirst = r)),
		);
		fetchStatusMessage.mockResolvedValueOnce("second");
		setup();
		fireEvent.click(editButton());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(editButton());
		await waitFor(() => expect(input().value).toBe("second"));
		resolveFirst("first");
		await Promise.resolve();
		expect(input().value).toBe("second");
	});
});
