import { createEffect, createSignal, For, Show } from "solid-js";
import { parsePermissionLevel } from "./permissionEditor";

export interface PermissionLevelControlProps {
	label: string;
	value: number | undefined;
	inherited: number | undefined;
	explicit: boolean;
	disabled: boolean;
	onChange: (level: number | null) => void;
}

export function PermissionLevelControl(props: PermissionLevelControlProps) {
	const [custom, setCustom] = createSignal("");
	const [invalid, setInvalid] = createSignal(false);
	createEffect(() => {
		setCustom(props.value === undefined ? "" : String(props.value));
		setInvalid(false);
	});
	return (
		<div class="space-y-2 border-b border-border-subtle py-3">
			<div class="text-sm font-medium text-text-primary">{props.label}</div>
			<p class="text-xs text-text-muted">
				{props.explicit ? "Explicit override" : "Inherited"}:{" "}
				{props.value ?? "message / state default"}
			</p>
			<div class="flex flex-wrap items-center gap-2">
				<For
					each={[
						{ value: 0, label: "Members" },
						{ value: 50, label: "Moderators" },
						{ value: 100, label: "Admins" },
					]}
				>
					{(option) => (
						<button
							type="button"
							disabled={props.disabled}
							aria-label={`${props.label}: ${option.label}`}
							aria-pressed={props.value === option.value}
							class="rounded border border-border-subtle px-3 py-1 text-xs text-text-primary hover:bg-surface-3 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
							classList={{ "bg-accent": props.value === option.value }}
							onClick={() => props.onChange(option.value)}
						>
							{option.label}
						</button>
					)}
				</For>
				<form
					class="flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (props.disabled) return;
						const value = parsePermissionLevel(custom());
						setInvalid(value === null);
						if (value !== null) props.onChange(value);
					}}
				>
					<input
						type="text"
						inputmode="numeric"
						aria-label={`${props.label}: custom level`}
						aria-invalid={invalid()}
						disabled={props.disabled}
						value={custom()}
						onInput={(e) => setCustom(e.currentTarget.value)}
						class="w-24 rounded border border-border-subtle bg-surface-1 px-2 py-1 text-sm text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
					/>
					<button
						type="submit"
						disabled={props.disabled}
						aria-label={`${props.label}: apply custom level`}
						class="rounded px-2 py-1 text-xs text-text-primary hover:bg-surface-3 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
					>
						Apply
					</button>
				</form>
				<button
					type="button"
					disabled={props.disabled || !props.explicit}
					aria-label={`${props.label}: reset`}
					onClick={() => props.onChange(null)}
					class="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-3 disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
				>
					Reset
					{props.inherited !== undefined
						? ` (${props.inherited})`
						: " to default"}
				</button>
			</div>
			<Show when={invalid()}>
				<p role="alert" class="text-xs text-danger-text">
					Enter a whole-number power level.
				</p>
			</Show>
		</div>
	);
}
