import {
	type Component,
	createEffect,
	createSignal,
	type JSX,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { HotkeyCaptureButton } from "../features/voice/HotkeyCaptureButton";
import { updateSetting, userSettings } from "../stores/settings";
import { micEnabled, toggleUserWantsMic, userWantsMic } from "../stores/voice";
import { Avatar } from "./Avatar";

interface UserBarProps {
	displayName: string;
	userId: string;
	initial: string;
	avatarUrl: string | null;
	syncStatus: "live" | "catching-up" | "stopped";
	needsCryptoAttention: boolean;
	cryptoLabel: string;
	onCryptoClick: () => void;
	onSettingsClick: () => void;
}

// --- SVG icon helpers (inline, no deps) ---

const MicIcon: Component<{ muted: boolean }> = (props) => (
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
		<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
		<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
		<line x1="12" y1="19" x2="12" y2="23" />
		<line x1="8" y1="23" x2="16" y2="23" />
		<Show when={props.muted}>
			<line x1="1" y1="1" x2="23" y2="23" class="text-danger-text" />
		</Show>
	</svg>
);

const HeadsetIcon: Component<{ deafened: boolean }> = (props) => (
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
		<path d="M3 18v-6a9 9 0 0 1 18 0v6" />
		<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
		<path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
		<Show when={props.deafened}>
			<line x1="1" y1="1" x2="23" y2="23" class="text-danger-text" />
		</Show>
	</svg>
);

const GearIcon: Component = () => (
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
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
	</svg>
);

const ChevronUpIcon: Component = () => (
	<svg
		class="h-3 w-3"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="3"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<polyline points="18 15 12 9 6 15" />
	</svg>
);

// --- Split button (icon + dropdown arrow) ---

const SplitAudioButton: Component<{
	icon: JSX.Element;
	active: boolean;
	label: string;
	onToggle: () => void;
	menuContent: JSX.Element;
}> = (props) => {
	const [menuOpen, setMenuOpen] = createSignal(false);
	let containerRef: HTMLDivElement | undefined;

	// Outside-click listener. Safe to attach synchronously because the
	// opening mousedown fires before onClick → setMenuOpen(true), so
	// the listener is never reached by the opening click's mousedown.
	createEffect(
		on(menuOpen, (open) => {
			if (!open) return;
			const handler = (e: MouseEvent): void => {
				if (containerRef && !containerRef.contains(e.target as Node)) {
					setMenuOpen(false);
				}
			};
			document.addEventListener("mousedown", handler);
			onCleanup(() => {
				document.removeEventListener("mousedown", handler);
			});
		}),
	);

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") setMenuOpen(false);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: flex split-button layout prevents fieldset use
		<div
			class="relative flex"
			ref={containerRef}
			role="group"
			onKeyDown={handleKeyDown}
		>
			{/* Main toggle */}
			<button
				type="button"
				onClick={props.onToggle}
				class={`flex h-8 w-8 items-center justify-center rounded-l transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover ${
					props.active
						? "text-danger-text hover:bg-surface-3"
						: "text-text-muted hover:bg-surface-3 hover:text-text-primary"
				}`}
				aria-label={props.label}
			>
				{props.icon}
			</button>
			{/* Dropdown arrow */}
			<button
				type="button"
				onClick={() => setMenuOpen((v) => !v)}
				class="flex h-8 w-4 items-center justify-center rounded-r transition-colors text-text-muted hover:bg-surface-3 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				aria-label={`${props.label} options`}
				aria-expanded={menuOpen()}
			>
				<ChevronUpIcon />
			</button>

			{/* Drop-up menu */}
			<Show when={menuOpen()}>
				<div class="absolute bottom-full left-0 z-30 mb-1 min-w-48 rounded-lg bg-surface-3 p-3 shadow-xl">
					{props.menuContent}
				</div>
			</Show>
		</div>
	);
};

// --- Volume slider (reusable for mic and headset menus) ---

const VolumeSlider: Component<{
	label: string;
	value: number;
	onChange: (v: number) => void;
}> = (props) => (
	<div class="flex flex-col gap-1.5">
		<span class="text-xs font-medium text-text-secondary">{props.label}</span>
		<input
			type="range"
			min="0"
			max="100"
			value={props.value}
			onInput={(e) => props.onChange(Number(e.currentTarget.value))}
			class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
			aria-label={props.label}
		/>
	</div>
);

// --- Sync status subtitle (shared by both UserBar variants) ---

const SyncStatusLine: Component<{
	syncStatus: "live" | "catching-up" | "stopped";
	userId: string;
}> = (props) => (
	<Show
		when={props.syncStatus === "live"}
		fallback={
			<div
				class="truncate text-xs leading-tight"
				classList={{
					"motion-safe:animate-pulse text-warning-text":
						props.syncStatus === "catching-up",
					"text-danger-text": props.syncStatus === "stopped",
				}}
				title={`${props.syncStatus === "catching-up" ? "Reconnecting to homeserver" : "Sync stopped"} \u00b7 ${props.userId}`}
				role="status"
			>
				{props.syncStatus === "catching-up"
					? "Reconnecting\u2026"
					: "Disconnected"}
			</div>
		}
	>
		<div class="truncate text-xs leading-tight text-text-muted">
			{props.userId}
		</div>
	</Show>
);

const MicConfigMenu: Component = () => {
	const settings = userSettings;
	const showHotkeyUi = (): boolean => settings().micMode !== "voice-activity";
	const needsBinding = (): boolean =>
		settings().micMode !== "voice-activity" && settings().micHotkey === null;
	return (
		<div class="mt-3 border-t border-border-subtle pt-2">
			<label class="block">
				<span class="mb-1 block text-xs font-semibold text-text-secondary">
					Mic mode
				</span>
				<select
					value={settings().micMode}
					onChange={(e) => {
						const v = e.currentTarget.value;
						if (
							v === "voice-activity" ||
							v === "push-to-talk" ||
							v === "push-to-mute"
						) {
							updateSetting("micMode", v);
						}
					}}
					class="w-full rounded bg-surface-2 px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:min-h-11 any-pointer-coarse:py-3 any-pointer-coarse:text-sm"
					aria-label="Microphone transmission mode"
				>
					<option value="voice-activity">Voice activity</option>
					<option value="push-to-talk">Push to talk</option>
					<option value="push-to-mute">Push to mute</option>
				</select>
			</label>
			<Show when={showHotkeyUi()}>
				<div class="mt-2">
					<span class="mb-1 block text-xs font-semibold text-text-secondary">
						Hotkey
					</span>
					<HotkeyCaptureButton />
					<Show when={needsBinding()}>
						<p class="mt-1 text-[10px] leading-snug text-warning-text">
							Bind a key to enable this mode — until then the mic stays
							always-on.
						</p>
					</Show>
				</div>
			</Show>
		</div>
	);
};

// --- Main UserBar ---

const UserBar: Component<UserBarProps> = (props) => {
	const [deafened, setDeafened] = createSignal(false);
	const [micVolume, setMicVolume] = createSignal(100);
	const [outputVolume, setOutputVolume] = createSignal(100);

	// Mic icon reflects the LIVE transmission intent: `!micEnabled()` is
	// true when the user has clicked mute OR when PTT/PTM mode says we
	// aren't currently transmitting (e.g. PTT key not held). This matches
	// Discord's "muted-look while not transmitting" pattern.
	const micIconMuted = (): boolean => !micEnabled();
	const micButtonActive = (): boolean => !userWantsMic();

	return (
		<div class="flex h-[52px] shrink-0 items-center gap-1 border-t border-border-subtle bg-surface-1 px-2">
			{/* Avatar + user info */}
			<Show
				when={props.needsCryptoAttention}
				fallback={
					<div class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1">
						<Avatar url={props.avatarUrl} initial={props.initial} />
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-semibold leading-tight text-text-primary">
								{props.displayName}
							</div>
							<SyncStatusLine
								syncStatus={props.syncStatus}
								userId={props.userId}
							/>
						</div>
					</div>
				}
			>
				<button
					type="button"
					onClick={props.onCryptoClick}
					class="group relative flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 transition-colors hover:bg-surface-2"
					title={
						props.syncStatus === "live"
							? props.cryptoLabel
							: `${props.syncStatus === "catching-up" ? "Reconnecting" : "Disconnected"} \u00b7 ${props.cryptoLabel}`
					}
					aria-label={`${props.displayName} \u2014 ${props.syncStatus !== "live" ? `${props.syncStatus === "catching-up" ? "Reconnecting" : "Disconnected"} \u2014 ` : ""}${props.cryptoLabel}`}
				>
					<div class="relative">
						<Avatar url={props.avatarUrl} initial={props.initial} />
						<span
							class="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-warning text-[8px] font-bold text-text-primary"
							aria-hidden="true"
						>
							!
						</span>
					</div>
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-semibold leading-tight text-text-primary">
							{props.displayName}
						</div>
						<SyncStatusLine
							syncStatus={props.syncStatus}
							userId={props.userId}
						/>
					</div>
				</button>
			</Show>

			{/* Mic split button */}
			<SplitAudioButton
				icon={<MicIcon muted={micIconMuted()} />}
				active={micButtonActive()}
				label={userWantsMic() ? "Mute microphone" : "Unmute microphone"}
				onToggle={toggleUserWantsMic}
				menuContent={
					<>
						<div class="mb-2 text-xs font-semibold text-text-secondary">
							Microphone
						</div>
						<VolumeSlider
							label="Input volume"
							value={micVolume()}
							onChange={setMicVolume}
						/>
						<MicConfigMenu />
					</>
				}
			/>

			{/* Headset split button */}
			<SplitAudioButton
				icon={<HeadsetIcon deafened={deafened()} />}
				active={deafened()}
				label={deafened() ? "Undeafen" : "Deafen"}
				onToggle={() => setDeafened((v) => !v)}
				menuContent={
					<>
						<div class="mb-2 text-xs font-semibold text-text-secondary">
							Audio Output
						</div>
						<VolumeSlider
							label="Output volume"
							value={outputVolume()}
							onChange={setOutputVolume}
						/>
					</>
				}
			/>

			{/* Settings gear */}
			<button
				type="button"
				onClick={props.onSettingsClick}
				class="flex h-8 w-8 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				aria-label="User settings"
			>
				<GearIcon />
			</button>
		</div>
	);
};

export { UserBar };
