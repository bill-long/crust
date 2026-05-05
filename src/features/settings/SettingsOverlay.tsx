import {
	type Component,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Switch,
} from "solid-js";
import { AccountTab } from "./AccountTab";
import { DevicesTab } from "./DevicesTab";
import { GeneralTab } from "./GeneralTab";
import { NotificationsTab } from "./NotificationsTab";

type SettingsTab = "general" | "account" | "notifications" | "devices";

interface SettingsOverlayProps {
	onClose: () => void;
	onLogout: () => void;
}

const tabMeta: { id: SettingsTab; label: string }[] = [
	{ id: "general", label: "General" },
	{ id: "account", label: "Account" },
	{ id: "notifications", label: "Notifications" },
	{ id: "devices", label: "Devices & Security" },
];

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

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SettingsOverlay: Component<SettingsOverlayProps> = (props) => {
	const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
	let overlayRef!: HTMLDivElement;
	let previousFocus: HTMLElement | null = null;

	onMount(() => {
		previousFocus = document.activeElement as HTMLElement;
		// Focus first tabbable element so Tab/Shift+Tab trap works correctly
		const first = overlayRef.querySelector<HTMLElement>(FOCUSABLE);
		(first ?? overlayRef).focus();
	});

	onCleanup(() => {
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
	});

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			props.onClose();
			return;
		}

		// Focus trap
		if (e.key === "Tab") {
			const focusable = Array.from(
				overlayRef.querySelectorAll<HTMLElement>(FOCUSABLE),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	};

	const tabTitle = () => tabMeta.find((t) => t.id === activeTab())?.label ?? "";

	return (
		<div
			ref={overlayRef}
			class="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			onClick={(e) => {
				if (e.target === e.currentTarget) props.onClose();
			}}
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
										onClick={() => setActiveTab(tab.id)}
										class="w-full rounded px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
										classList={{
											"bg-surface-2 text-text-primary font-medium":
												activeTab() === tab.id,
											"text-text-secondary hover:bg-surface-2/50 hover:text-text-primary":
												activeTab() !== tab.id,
										}}
										aria-current={activeTab() === tab.id ? "page" : undefined}
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
						<button
							type="button"
							onClick={props.onLogout}
							class="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							<LogoutIcon />
							Log Out
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
							class="flex items-center gap-2 rounded p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Close settings"
						>
							<CloseIcon />
							<kbd class="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-disabled">
								ESC
							</kbd>
						</button>
					</div>

					{/* Scrollable tab content */}
					<div class="flex-1 overflow-y-auto px-8 py-6">
						<div class="max-w-2xl">
							<Switch>
								<Match when={activeTab() === "general"}>
									<GeneralTab />
								</Match>
								<Match when={activeTab() === "account"}>
									<AccountTab />
								</Match>
								<Match when={activeTab() === "notifications"}>
									<NotificationsTab />
								</Match>
								<Match when={activeTab() === "devices"}>
									<DevicesTab />
								</Match>
							</Switch>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export { SettingsOverlay };
