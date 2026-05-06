import type { Component } from "solid-js";
import { createUniqueId, Show } from "solid-js";

interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	describedBy?: string;
	disabled?: boolean;
}

const Toggle: Component<ToggleProps> = (props) => (
	<button
		type="button"
		role="switch"
		aria-checked={props.checked}
		aria-label={props.label}
		aria-describedby={props.describedBy}
		disabled={props.disabled || undefined}
		onClick={() => {
			if (!props.disabled) props.onChange(!props.checked);
		}}
		class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
		classList={{
			"cursor-pointer": !props.disabled,
			"cursor-not-allowed": !!props.disabled,
			"bg-accent": props.checked,
			"bg-surface-3": !props.checked,
		}}
	>
		<span
			class="inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform"
			classList={{
				"translate-x-4": props.checked,
				"translate-x-0.5": !props.checked,
			}}
		/>
	</button>
);

interface ToggleRowProps {
	label: string;
	description?: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
}

const ToggleRow: Component<ToggleRowProps> = (props) => {
	const descId = createUniqueId();

	return (
		<div
			class="flex items-center justify-between gap-4 py-2"
			classList={{ "opacity-50": !!props.disabled }}
		>
			<div class="min-w-0 flex-1">
				<div class="text-sm font-medium text-text-primary">{props.label}</div>
				<Show when={props.description}>
					<div id={descId} class="text-xs text-text-muted">
						{props.description}
					</div>
				</Show>
			</div>
			<Toggle
				checked={props.checked}
				onChange={props.onChange}
				label={props.label}
				describedBy={props.description ? descId : undefined}
				disabled={props.disabled}
			/>
		</div>
	);
};

/** Section heading used across settings tabs. */
const SectionHeading: Component<{ children: string }> = (props) => (
	<h3 class="mb-4 text-xs font-semibold uppercase tracking-wide text-text-muted">
		{props.children}
	</h3>
);

export { SectionHeading, Toggle, ToggleRow };
