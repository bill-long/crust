import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { type AccountSummary, AccountSwitcher } from "./AccountSwitcher";

const ALICE: AccountSummary = {
	userId: "@alice:example.com",
	displayName: "Alice",
	initial: "A",
	avatarUrl: "https://media.example.com/alice.png",
};
const BOB: AccountSummary = {
	userId: "@bob:example.com",
	displayName: "Alice",
	initial: "A",
	avatarUrl: null,
};

interface Handlers {
	onSwitchAccount: Mock<(userId: string) => void>;
	onAddAccount: Mock<() => void>;
	onLogOutAccount: Mock<(userId: string) => void>;
}

function setup(
	overrides: Partial<{
		accounts: AccountSummary[];
		activeUserId: string;
		canAddAccount: boolean;
		busy: boolean;
	}> = {},
): Handlers {
	const handlers: Handlers = {
		onSwitchAccount: vi.fn<(userId: string) => void>(),
		onAddAccount: vi.fn<() => void>(),
		onLogOutAccount: vi.fn<(userId: string) => void>(),
	};
	render(() => (
		<AccountSwitcher
			accounts={overrides.accounts ?? [ALICE, BOB]}
			activeUserId={overrides.activeUserId ?? ALICE.userId}
			canAddAccount={overrides.canAddAccount ?? true}
			maxAccounts={5}
			busy={overrides.busy ?? false}
			onSwitchAccount={handlers.onSwitchAccount}
			onAddAccount={handlers.onAddAccount}
			onLogOutAccount={handlers.onLogOutAccount}
			triggerClass="trigger"
			triggerLabel="Alice — switch account"
		>
			<span>Alice</span>
		</AccountSwitcher>
	));
	return handlers;
}

// Kobalte opens on pointer events, which jsdom does not synthesize from a
// plain click; the repo's other menu tests fire the same sequence.
function press(el: Element): void {
	fireEvent.pointerMove(el, { pointerType: "mouse" });
	fireEvent.pointerDown(el, { button: 0, pointerType: "mouse" });
	fireEvent.pointerUp(el, { button: 0, pointerType: "mouse" });
	fireEvent.click(el);
	fireEvent.keyDown(el, { key: "Enter" });
}

async function openMenu(): Promise<void> {
	press(screen.getByLabelText("Alice \u2014 switch account"));
	await waitFor(() => expect(screen.getByText("Accounts")).toBeTruthy());
}

beforeEach(() => {
	// Kobalte's focus management calls scrollTo, which jsdom does not implement.
	window.scrollTo = vi.fn();
});

afterEach(cleanup);

describe("AccountSwitcher", () => {
	it("lists every account with its MXID", async () => {
		setup();
		await openMenu();
		// Both accounts carry the SAME display name on purpose: the MXID is what
		// tells them apart, so it has to be rendered for every row.
		expect(screen.getByText(ALICE.userId)).toBeTruthy();
		expect(screen.getByText(BOB.userId)).toBeTruthy();
	});

	it("marks the active account for screen readers, not just visually", async () => {
		setup();
		await openMenu();
		expect(screen.getByText("(current account)")).toBeTruthy();
	});

	it("switches to another account", async () => {
		const handlers = setup();
		await openMenu();
		press(screen.getByText(BOB.userId));
		await waitFor(() =>
			expect(handlers.onSwitchAccount).toHaveBeenCalledWith(BOB.userId),
		);
	});

	it("does not switch to the account already active", async () => {
		const handlers = setup();
		await openMenu();
		press(screen.getByText(ALICE.userId));
		expect(handlers.onSwitchAccount).not.toHaveBeenCalled();
	});

	it("offers to add an account", async () => {
		const handlers = setup();
		await openMenu();
		press(screen.getByText("Add account"));
		await waitFor(() => expect(handlers.onAddAccount).toHaveBeenCalledOnce());
	});

	it("explains the cap instead of silently doing nothing at the limit", async () => {
		const handlers = setup({ canAddAccount: false });
		await openMenu();
		expect(screen.getByText(/Limit of 5 accounts reached/)).toBeTruthy();
		press(screen.getByText("Add account"));
		expect(handlers.onAddAccount).not.toHaveBeenCalled();
	});

	it("goes inert while a switch is already running", async () => {
		const handlers = setup({ busy: true });
		await openMenu();
		press(screen.getByText(BOB.userId));
		press(screen.getByText("Add account"));
		expect(handlers.onSwitchAccount).not.toHaveBeenCalled();
		expect(handlers.onAddAccount).not.toHaveBeenCalled();
	});

	it("logs an account out from the submenu", async () => {
		const handlers = setup();
		await openMenu();
		press(screen.getByText("Log out of"));
		await waitFor(() =>
			expect(screen.getAllByText(BOB.userId).length).toBeGreaterThan(1),
		);
		// The submenu row, not the switch row above it.
		const rows = screen.getAllByText(BOB.userId);
		const last = rows[rows.length - 1];
		if (!last) throw new Error("expected a submenu row");
		press(last);
		await waitFor(() =>
			expect(handlers.onLogOutAccount).toHaveBeenCalledWith(BOB.userId),
		);
	});

	it("draws no separator above the accounts without a leading item", async () => {
		// A conditional element (a `<Show>`) is a function and always truthy, so
		// gating on it would print an empty divider for every user with nothing
		// to show there.
		setup();
		await openMenu();
		// Kobalte renders separators as <hr> (implicit separator role).
		const menu = screen.getByText("Accounts").closest('[role="menu"]');
		expect(menu?.querySelectorAll("hr").length).toBe(1);
	});

	it("a leading DropdownMenu.Item built by the CALLER still works as a menu item", async () => {
		// It is created outside this component's <DropdownMenu>, so it only gets
		// the menu context if the prop getter is evaluated inside Content - which
		// is what the <Show> below Content does. Assert the item actually selects,
		// not merely that its text renders.
		const onSelect = vi.fn();
		render(() => (
			<AccountSwitcher
				accounts={[ALICE]}
				activeUserId={ALICE.userId}
				canAddAccount
				maxAccounts={5}
				busy={false}
				onSwitchAccount={vi.fn()}
				onAddAccount={vi.fn()}
				onLogOutAccount={vi.fn()}
				triggerClass="trigger"
				triggerLabel="Alice — switch account"
				leadingItem={
					<DropdownMenu.Item onSelect={onSelect}>
						Verify this session
					</DropdownMenu.Item>
				}
			>
				<span>Alice</span>
			</AccountSwitcher>
		));
		await openMenu();
		press(screen.getByText("Verify this session"));
		await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
	});

	it("renders a leading item above the accounts when given one", async () => {
		render(() => (
			<AccountSwitcher
				accounts={[ALICE]}
				activeUserId={ALICE.userId}
				canAddAccount
				maxAccounts={5}
				busy={false}
				onSwitchAccount={vi.fn()}
				onAddAccount={vi.fn()}
				onLogOutAccount={vi.fn()}
				triggerClass="trigger"
				triggerLabel="Alice — switch account"
				leadingItem={<div>Verify this device</div>}
			>
				<span>Alice</span>
			</AccountSwitcher>
		));
		await openMenu();
		expect(screen.getByText("Verify this device")).toBeTruthy();
		const menu = screen.getByText("Accounts").closest('[role="menu"]');
		expect(menu?.querySelectorAll("hr").length).toBe(2);
	});
});
