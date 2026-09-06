import {
	type Accessor,
	type Component,
	createEffect,
	For,
	Match,
	on,
	Switch,
} from "solid-js";
import { Modal } from "../../components/Modal";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { userSettings } from "../../stores/settings";
import { AccountTab } from "./AccountTab";
import { AppGeneralTab } from "./AppGeneralTab";
import { DevicesTab } from "./DevicesTab";
import { NotificationsTab } from "./NotificationsTab";
import { type SettingsTab, tabMeta } from "./settingsTabs";

export type { SettingsTab } from "./settingsTabs";
// Re-exported so existing import sites (Layout.tsx lazy mapping, tests) keep
// working; the canonical home is ./settingsTabs so non-overlay modules can
// import the tab registry without pulling in this component module (#307).
export { tabMeta };

interface SettingsOverlayProps {
	activeTab: SettingsTab;
	onTabChange: (tab: SettingsTab) => void;
	onClose: () => void;
	onLogout: () => void;
	/** True while the logout is in flight — surfaces a pending state on the
	 * button so a slow logout (it awaits the call teardown) doesn't look
	 * like nothing happened, and makes it non-operable while it does. */
	loggingOut?: Accessor<boolean> | undefined;
}

const CloseIcon: Component = () => (
	<svg
		class="h-5 w-5"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<line x1="18" y1="6" x2="6" y2="18" />
		<line x1="6" y1="6" x2="18" y2="18" />
	</svg>
);

const LogoutIcon: Component = () => (
	<svg
		class="h-4 w-4"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<polyline points="16 17 21 12 16 7" />
		<line x1="21" y1="12" x2="9" y2="12" />
	</svg>
);

const SettingsOverlay: Component<SettingsOverlayProps> = (props) => {
	let contentRef!: HTMLDivElement;

	// Reset scroll position when switching tabs (skip initial mount)
	createEffect(
		on(
			() => props.activeTab,
			() => contentRef?.scrollTo(0, 0),
			{ defer: true },
		),
	);

	const tabTitle = () =>
		tabMeta.find((t) => t.id === props.activeTab)?.label ?? "";

	return (
		<Modal
			open
			onClose={props.onClose}
			class="fixed inset-0 z-40 flex items-center justify-center bg-surface-0/60"
			style={{ zoom: `${100 / userSettings().zoomLevel}` }}
			label={"Settings"}
			suspended={cryptoDialogOpen()}
		>
			{/* Modal panel */}
			<div class="flex h-[85vh] w-[min(960px,90vw)] overflow-hidden rounded-lg bg-surface-0 shadow-2xl">
				{/* ── Sidebar ── */}
				<nav class="flex w-56 shrink-0 flex-col rounded-l-lg bg-surface-1">
					<div class="flex-1 overflow-y-auto px-2 pt-6">
						<div class="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
							User Settings
						</div>
						<div class="space-y-0.5">
							<For each={tabMeta}>
								{(tab) => (
									<button
										type="button"
										onClick={() => props.onTabChange(tab.id)}
										class="w-full rounded px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
										classList={{
											"bg-surface-2 text-text-primary font-medium":
												props.activeTab === tab.id,
											"text-text-secondary hover:bg-surface-2/50 hover:text-text-primary":
												props.activeTab !== tab.id,
										}}
										aria-current={
											props.activeTab === tab.id ? "true" : undefined
										}
									>
										{tab.label}
									</button>
								)}
							</For>
						</div>
					</div>

					{/* Logout */}
					<div class="px-2 pb-4">
						<div class="mb-2 h-px bg-border-subtle" />
						{/* `aria-disabled`, not `disabled`: the user has just clicked
						    this button, so disabling it blurs it onto <body>, which
						    drops focus out of the overlay's focus trap AND past its
						    delegated keydown handler — Escape would stop closing the
						    modal for the whole logout. It stays focusable, so the
						    click handler has to honour the disabled state itself
						    rather than leave it to the caller: a control that
						    advertises `aria-disabled` must actually be inert. */}
						<button
							type="button"
							onClick={() => {
								if (props.loggingOut?.()) return;
								props.onLogout();
							}}
							aria-disabled={props.loggingOut?.() ?? false}
							class={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-danger-text transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover ${
								props.loggingOut?.()
									? "cursor-not-allowed opacity-60"
									: "hover:bg-danger-bg"
							}`}
						>
							<LogoutIcon />
							{props.loggingOut?.() ? "Logging out…" : "Log Out"}
						</button>
					</div>
				</nav>

				{/* ── Content ── */}
				<div class="flex flex-1 flex-col overflow-hidden">
					{/* Header */}
					<div class="flex shrink-0 items-center justify-between border-b border-border-subtle px-8 py-4">
						<h2 class="text-lg font-semibold text-text-primary">
							{tabTitle()}
						</h2>
						<button
							type="button"
							onClick={props.onClose}
							class="flex items-center gap-2 rounded p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Close settings"
						>
							<CloseIcon />
							<kbd class="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-disabled">
								ESC
							</kbd>
						</button>
					</div>

					{/* Scrollable tab content */}
					<div ref={contentRef} class="flex-1 overflow-y-auto px-8 py-6">
						<div class="max-w-2xl">
							<Switch>
								<Match when={props.activeTab === "general"}>
									<AppGeneralTab />
								</Match>
								<Match when={props.activeTab === "account"}>
									<AccountTab onDeactivated={props.onLogout} />
								</Match>
								<Match when={props.activeTab === "notifications"}>
									<NotificationsTab />
								</Match>
								<Match when={props.activeTab === "devices"}>
									<DevicesTab />
								</Match>
							</Switch>
						</div>
					</div>
				</div>
			</div>
		</Modal>
	);
};

export { SettingsOverlay };
