import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { type Component, For, type JSX, Show } from "solid-js";
import { Avatar } from "./Avatar";

/** One row of the switcher. Plain identity data - no Matrix types here. */
export interface AccountSummary {
	userId: string;
	/** Falls back to the user ID upstream when the account has no profile name. */
	displayName: string;
	/** Single character for the fallback avatar. */
	initial: string;
	/**
	 * Only ever set for the ACTIVE account. Avatars are authenticated media
	 * (MSC3916) fetched with the owning account's token, and only one account's
	 * token is live at a time, so an inactive row shows its initial rather than
	 * asking the current account to fetch someone else's picture.
	 */
	avatarUrl: string | null;
}

interface AccountSwitcherProps {
	accounts: AccountSummary[];
	activeUserId: string;
	/** False once the install is at the account cap. */
	canAddAccount: boolean;
	/** The cap, for the message shown when it is reached. */
	maxAccounts: number;
	/** True while a switch or a log-out is in flight; the menu goes inert. */
	busy: boolean;
	onSwitchAccount: (userId: string) => void;
	onAddAccount: () => void;
	onLogOutAccount: (userId: string) => void;
	/**
	 * Extra item rendered above the accounts (the crypto-attention action).
	 * Must be undefined when there is nothing to show: a conditional element -
	 * a `<Show>` - is a function and therefore always truthy, which would render
	 * a separator over nothing.
	 */
	leadingItem?: JSX.Element;
	/** Classes for the trigger, which wraps the caller's identity block. */
	triggerClass: string;
	triggerLabel: string;
	triggerTitle?: string;
	children: JSX.Element;
}

const CheckIcon: Component = () => (
	<svg
		class="h-4 w-4 shrink-0 text-accent"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<title>Active account</title>
		<path d="M20 6 9 17l-5-5" />
	</svg>
);

const PlusIcon: Component = () => (
	<svg
		class="h-4 w-4 shrink-0"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="M12 5v14M5 12h14" />
	</svg>
);

const itemClass =
	"flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-hidden";

/**
 * Discord-style account switcher (#533): the bottom-left identity block opens a
 * menu listing every account on this install, with the current one checked.
 *
 * Selecting another account switches to it, which reloads the app - so the menu
 * only ever reports the intent and lets the shell own the teardown. Log-out
 * lives in a submenu rather than as a button inside each row: a nested control
 * inside a `menuitem` breaks the menu's keyboard model, and removing an account
 * is the rarer, more destructive action of the two.
 */
export const AccountSwitcher: Component<AccountSwitcherProps> = (props) => {
	const label = (account: AccountSummary): string =>
		account.displayName || account.userId;

	return (
		<DropdownMenu placement="top-start" gutter={6}>
			<DropdownMenu.Trigger
				class={props.triggerClass}
				aria-label={props.triggerLabel}
				title={props.triggerTitle}
			>
				{props.children}
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content class="portal-scale z-50 min-w-[240px] max-w-[320px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
					<Show when={props.leadingItem}>
						{(item) => (
							<>
								{item()}
								<DropdownMenu.Separator class="my-1 border-t border-border-subtle" />
							</>
						)}
					</Show>
					<DropdownMenu.Group>
						<DropdownMenu.GroupLabel class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
							Accounts
						</DropdownMenu.GroupLabel>
						<For each={props.accounts}>
							{(account) => (
								<DropdownMenu.Item
									class={itemClass}
									classList={{
										"bg-surface-2": account.userId === props.activeUserId,
										"pointer-events-none opacity-50": props.busy,
									}}
									disabled={props.busy}
									onSelect={() => {
										if (account.userId === props.activeUserId) return;
										props.onSwitchAccount(account.userId);
									}}
								>
									<Avatar
										url={account.avatarUrl}
										initial={account.initial}
										loading="lazy"
									/>
									<span class="flex min-w-0 flex-1 flex-col">
										<span class="truncate font-medium text-text-primary">
											{label(account)}
										</span>
										{/* The MXID is what tells two accounts with the same
										    display name apart, so it is never truncated away
										    from the row - only within it. */}
										<span class="truncate text-[11px] text-text-muted">
											{account.userId}
										</span>
									</span>
									<Show when={account.userId === props.activeUserId}>
										<CheckIcon />
										<span class="sr-only">(current account)</span>
									</Show>
								</DropdownMenu.Item>
							)}
						</For>
					</DropdownMenu.Group>
					<DropdownMenu.Separator class="my-1 border-t border-border-subtle" />
					<DropdownMenu.Item
						class={itemClass}
						classList={{
							"pointer-events-none opacity-50":
								!props.canAddAccount || props.busy,
						}}
						disabled={!props.canAddAccount || props.busy}
						onSelect={props.onAddAccount}
					>
						<PlusIcon />
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="text-text-primary">Add account</span>
							<Show when={!props.canAddAccount}>
								<span class="text-[11px] text-text-muted">
									{`Limit of ${props.maxAccounts} accounts reached`}
								</span>
							</Show>
						</span>
					</DropdownMenu.Item>
					<DropdownMenu.Sub>
						<DropdownMenu.SubTrigger
							class={itemClass}
							classList={{ "pointer-events-none opacity-50": props.busy }}
							disabled={props.busy}
						>
							<span class="flex-1 text-text-primary">Log out of</span>
							<span aria-hidden="true" class="text-text-muted">
								›
							</span>
						</DropdownMenu.SubTrigger>
						<DropdownMenu.Portal>
							<DropdownMenu.SubContent class="portal-scale z-50 min-w-[220px] max-w-[320px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
								<For each={props.accounts}>
									{(account) => (
										<DropdownMenu.Item
											class={itemClass}
											classList={{
												"pointer-events-none opacity-50": props.busy,
											}}
											disabled={props.busy}
											onSelect={() => props.onLogOutAccount(account.userId)}
										>
											<span class="flex min-w-0 flex-1 flex-col">
												<span class="truncate text-text-primary">
													{label(account)}
												</span>
												<span class="truncate text-[11px] text-text-muted">
													{account.userId}
												</span>
											</span>
										</DropdownMenu.Item>
									)}
								</For>
							</DropdownMenu.SubContent>
						</DropdownMenu.Portal>
					</DropdownMenu.Sub>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu>
	);
};
