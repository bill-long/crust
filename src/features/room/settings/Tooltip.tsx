import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { type Component, type JSX, Show } from "solid-js";

interface TooltipProps {
	/** Tooltip text. When omitted/empty no tooltip is shown. */
	content: string;
	/** Element that receives the tooltip — usually a button or label. */
	children: JSX.Element;
	/** Placement preference. Defaults to "top". */
	placement?: "top" | "bottom" | "left" | "right";
	/** Open delay in ms. Defaults to 200. */
	openDelay?: number;
	/** Disable the tooltip entirely (renders children alone). */
	disabled?: boolean;
}

/**
 * Thin wrapper around Kobalte Tooltip with sensible defaults for the
 * Room Settings surface. Portals to the document body and styles itself
 * against the dark-mode design tokens.
 *
 * Important: native `<button disabled>` doesn't fire pointer/keyboard
 * events and isn't focusable, so the tooltip's trigger never sees
 * hover or focus. For disabled controls, render them as
 * `aria-disabled="true"` on a focusable element instead of `disabled`.
 */
const Tooltip: Component<TooltipProps> = (props) => {
	return (
		<Show when={!props.disabled && !!props.content} fallback={props.children}>
			<KTooltip
				openDelay={props.openDelay ?? 200}
				placement={props.placement ?? "top"}
			>
				<KTooltip.Trigger as="span" class="inline-flex">
					{props.children}
				</KTooltip.Trigger>
				<KTooltip.Portal>
					<KTooltip.Content class="z-50 max-w-xs rounded bg-surface-3 px-2 py-1 text-xs text-text-primary shadow-lg">
						{props.content}
					</KTooltip.Content>
				</KTooltip.Portal>
			</KTooltip>
		</Show>
	);
};

export { Tooltip };
