import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	For,
	Match,
	on,
	onCleanup,
	onMount,
	Switch,
} from "solid-js";
import { userSettings } from "../../../stores/settings";
import { AdvancedTab } from "./AdvancedTab";
import { GeneralTab } from "./GeneralTab";
import { MembersTab } from "./MembersTab";
import { PermissionsTab } from "./PermissionsTab";

export const roomSettingsTabMeta = [
	{ id: "general", label: "General" },
	{ id: "permissions", label: "Permissions" },
	{ id: "members", label: "Members" },
	{ id: "advanced", label: "Advanced" },
] as const;

export type RoomSettingsTab = (typeof roomSettingsTabMeta)[number]["id"];

interface RoomSettingsOverlayProps {
	client: MatrixClient;
	roomId: string;
	activeTab: RoomSettingsTab;
	onTabChange: (tab: RoomSettingsTab) => void;
	onClose: () => void;
	/** Called when the Advanced tab finishes a Leave action. */
	onLeft?: (roomId: string) => void;
}

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

const RoomSettingsOverlay: Component<RoomSettingsOverlayProps> = (props) => {
	let overlayRef!: HTMLDivElement;
	let contentRef!: HTMLDivElement;
	let previousFocus: HTMLElement | null = null;

	onMount(() => {
		previousFocus = document.activeElement as HTMLElement;
		const first = overlayRef.querySelector<HTMLElement>(FOCUSABLE);
		(first ?? overlayRef).focus();
	});

	onCleanup(() => {
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
	});

	createEffect(
		on(
			() => props.activeTab,
			() => contentRef?.scrollTo(0, 0),
			{ defer: true },
		),
	);

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			props.onClose();
			return;
		}
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

	const tabTitle = (): string =>
		roomSettingsTabMeta.find((t) => t.id === props.activeTab)?.label ?? "";

	const roomName = (): string => {
		const room = props.client.getRoom(props.roomId);
		const name = room?.name?.trim();
		return name || props.roomId;
	};

	return (
		<div
			ref={overlayRef}
			class="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
			style={{ zoom: `${100 / userSettings().zoomLevel}` }}
			role="dialog"
			aria-modal="true"
			aria-label={`Room settings — ${roomName()}`}
			tabIndex={-1}
			onKeyDown={handleKeyDown}
			onClick={(e) => {
				if (e.target === e.currentTarget) props.onClose();
			}}
		>
			<div class="flex h-[85vh] w-[min(960px,90vw)] overflow-hidden rounded-lg bg-surface-0 shadow-2xl">
				<nav class="flex w-56 shrink-0 flex-col rounded-l-lg bg-surface-1">
					<div class="flex-1 overflow-y-auto px-2 pt-6">
						<div class="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
							Room Settings
						</div>
						<div
							class="mb-3 truncate px-3 text-sm font-medium text-text-primary"
							title={roomName()}
						>
							{roomName()}
						</div>
						<div class="space-y-0.5">
							<For each={roomSettingsTabMeta}>
								{(tab) => (
									<button
										type="button"
										onClick={() => props.onTabChange(tab.id)}
										class="w-full rounded px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
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
				</nav>

				<div class="flex flex-1 flex-col overflow-hidden">
					<div class="flex shrink-0 items-center justify-between border-b border-border-subtle px-8 py-4">
						<h2 class="text-lg font-semibold text-text-primary">
							{tabTitle()}
						</h2>
						<button
							type="button"
							onClick={props.onClose}
							class="flex items-center gap-2 rounded p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Close room settings"
						>
							<CloseIcon />
							<kbd class="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-disabled">
								ESC
							</kbd>
						</button>
					</div>

					<div ref={contentRef} class="flex-1 overflow-y-auto px-8 py-6">
						<div class="max-w-2xl">
							<Switch>
								<Match when={props.activeTab === "general"}>
									<GeneralTab client={props.client} roomId={props.roomId} />
								</Match>
								<Match when={props.activeTab === "permissions"}>
									<PermissionsTab client={props.client} roomId={props.roomId} />
								</Match>
								<Match when={props.activeTab === "members"}>
									<MembersTab client={props.client} roomId={props.roomId} />
								</Match>
								<Match when={props.activeTab === "advanced"}>
									<AdvancedTab
										client={props.client}
										roomId={props.roomId}
										onLeft={(rid) => {
											props.onLeft?.(rid);
											props.onClose();
										}}
									/>
								</Match>
							</Switch>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export { RoomSettingsOverlay };
