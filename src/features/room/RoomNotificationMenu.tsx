import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import {
	ClientEvent,
	type MatrixClient,
	type MatrixEvent,
} from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import {
	getRoomNotificationLevel,
	type RoomNotificationLevel,
	setRoomNotificationLevel,
} from "./roomNotificationLevel";

/** Bell icon — default state. */
const BellIcon: Component = () => (
	<svg
		aria-hidden="true"
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M6 13a2 2 0 0 0 4 0" />
		<path d="M12.5 10.5c-.7-.7-1.5-1.2-1.5-4.5a3 3 0 0 0-6 0c0 3.3-.8 3.8-1.5 4.5h9Z" />
	</svg>
);

/** Bell with slash — muted. */
const BellMutedIcon: Component = () => (
	<svg
		aria-hidden="true"
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M6 13a2 2 0 0 0 4 0" />
		<path d="M12.5 10.5c-.7-.7-1.5-1.2-1.5-4.5a3 3 0 0 0-6 0c0 3.3-.8 3.8-1.5 4.5h9Z" />
		<line x1="2" y1="2" x2="14" y2="14" />
	</svg>
);

/** Bell with dot — all messages (actively watching). */
const BellActiveIcon: Component = () => (
	<svg
		aria-hidden="true"
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M6 13a2 2 0 0 0 4 0" />
		<path d="M12.5 10.5c-.7-.7-1.5-1.2-1.5-4.5a3 3 0 0 0-6 0c0 3.3-.8 3.8-1.5 4.5h9Z" />
		<circle cx="12" cy="4" r="2.5" fill="currentColor" stroke="none" />
	</svg>
);

interface LevelOption {
	value: RoomNotificationLevel;
	label: string;
	description: string;
}

const LEVELS: LevelOption[] = [
	{
		value: "default",
		label: "Default",
		description: "DMs and mentions alert; other messages are silent",
	},
	{
		value: "all-messages",
		label: "All Messages",
		description: "Get notified for every message",
	},
	{
		value: "mentions-only",
		label: "Mentions Only",
		description: "Only @-mentions trigger notifications",
	},
	{
		value: "mute",
		label: "Mute",
		description: "No notifications at all from this room",
	},
];

interface RoomNotificationMenuProps {
	client: MatrixClient;
	roomId: string;
}

const RoomNotificationMenu: Component<RoomNotificationMenuProps> = (props) => {
	const [level, setLevel] = createSignal<RoomNotificationLevel>("default");
	const [saving, setSaving] = createSignal(false);

	// Re-sync level when roomId changes or push rules update server-side
	createEffect(() => {
		const rid = props.roomId;
		setLevel(getRoomNotificationLevel(props.client, rid));
	});

	const onAccountData = (event: MatrixEvent): void => {
		if (event.getType() === "m.push_rules") {
			setLevel(getRoomNotificationLevel(props.client, props.roomId));
		}
	};
	props.client.on(ClientEvent.AccountData, onAccountData);
	onCleanup(() => {
		props.client.off(ClientEvent.AccountData, onAccountData);
	});

	const handleSelect = (next: RoomNotificationLevel): void => {
		if (next === level() || saving()) return;
		const targetRoomId = props.roomId;
		setLevel(next);
		setSaving(true);
		setRoomNotificationLevel(props.client, targetRoomId, next)
			.catch(() => {
				// Re-read server state instead of restoring stale prev
				// (roomId may have changed during the request)
				setLevel(getRoomNotificationLevel(props.client, props.roomId));
			})
			.finally(() => {
				setSaving(false);
			});
	};

	const icon = () => {
		const l = level();
		if (l === "mute") return BellMutedIcon;
		if (l === "all-messages") return BellActiveIcon;
		return BellIcon;
	};

	const isNonDefault = () => level() !== "default";

	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				class="rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				classList={{
					"text-accent": isNonDefault(),
					"text-text-disabled hover:bg-surface-2 hover:text-text-secondary":
						!isNonDefault(),
				}}
				title="Notification settings"
				aria-label="Notification settings"
			>
				{(() => {
					const Icon = icon();
					return <Icon />;
				})()}
			</DropdownMenu.Trigger>

			<DropdownMenu.Portal>
				<DropdownMenu.Content class="z-50 min-w-[220px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg">
					<For each={LEVELS}>
						{(opt) => (
							<DropdownMenu.Item
								class="flex cursor-pointer flex-col rounded px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
								classList={{
									"bg-surface-2": level() === opt.value,
								}}
								onSelect={() => handleSelect(opt.value)}
							>
								<span class="text-xs font-medium text-text-primary">
									{opt.label}
								</span>
								<span class="text-[10px] text-text-muted">
									{opt.description}
								</span>
								<Show when={level() === opt.value}>
									<span class="sr-only">(current)</span>
								</Show>
							</DropdownMenu.Item>
						)}
					</For>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu>
	);
};

export { BellMutedIcon, RoomNotificationMenu };
