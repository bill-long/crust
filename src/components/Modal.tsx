import { Dialog } from "@kobalte/core/dialog";
import { type JSX, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { trapTabKey } from "../lib/focusTrap";
import { trackAppModalOpen } from "../stores/modalStack";

interface ModalProps {
	open: boolean;
	onClose: () => void;
	children: JSX.Element;
	labelledBy?: string | undefined;
	describedBy?: string | undefined;
	label?: string | undefined;
	/** Layout of the outer surface; focus styling remains shared. */
	class?: string | undefined;
	style?: JSX.CSSProperties | undefined;
	/** Escape an inert ancestor (e.g. key dialogs hosted inside Settings). */
	portaled?: boolean | undefined;
	fallbackFocus?: (() => HTMLElement | null | undefined) | undefined;
	onBackdropClick?: ((event: MouseEvent) => void) | undefined;
	/** Temporarily yield to a legacy dialog rendered above this one. */
	suspended?: boolean | undefined;
	/** A pending operation can prevent dismissal without leaking Escape. */
	dismissible?: boolean | undefined;
	initialFocus?: (() => HTMLElement | undefined) | undefined;
	contentRef?: ((element: HTMLDivElement) => void) | undefined;
	onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
}

/**
 * Shared app dialog shell. Feature components own their content and actions.
 * Inline by default to retain #root's zoom and existing stacking contexts.
 * Opt-in body portals escape inert ancestors and reapply root zoom once.
 */
export function Modal(props: ModalProps) {
	trackAppModalOpen(() => props.open);
	return (
		<Show when={props.open}>
			<Show when={props.portaled} fallback={<ModalSurface {...props} />}>
				<Portal>
					<ModalSurface {...props} />
				</Portal>
			</Show>
		</Show>
	);
}

// Per-opening ownership keeps delayed focus cleanup from sharing state
// with a dialog that has already reopened.
function ModalSurface(props: ModalProps) {
	let content: HTMLDivElement | undefined;
	let returnFocus: HTMLElement | undefined;

	const close = () => {
		if (!props.suspended && props.dismissible !== false) props.onClose();
	};

	return (
		<Dialog
			open
			modal={!props.suspended}
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<Dialog.Content
				ref={(element: HTMLDivElement) => {
					content = element;
					props.contentRef?.(element);
				}}
				class={`${props.class ?? "fixed inset-0 z-50 flex items-center justify-center bg-surface-0/60"} ${props.portaled ? "portal-scale" : ""} focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover`}
				style={props.style}
				aria-label={props.label}
				aria-labelledby={props.labelledBy}
				aria-describedby={props.describedBy}
				aria-modal={props.suspended ? undefined : "true"}
				inert={props.suspended || undefined}
				onOpenAutoFocus={(event) =>
					untrack(() => {
						// Kobalte dispatches this from its scope-creation effect.
						// App signals must not make that scope tear down and remount.
						returnFocus =
							document.activeElement instanceof HTMLElement
								? document.activeElement
								: undefined;
						if (props.suspended) {
							event.preventDefault();
							return;
						}
						if (props.initialFocus) {
							event.preventDefault();
							const initialTarget = props.initialFocus();
							initialTarget?.focus();
							if (!content?.contains(document.activeElement)) content?.focus();
							// Let the owner's open-time form reset mount its final field
							// (e.g. the pre-engaged knock reason). Only refocus if that
							// reset changed the target; ordinary dialogs focus once.
							queueMicrotask(() => {
								if (!content?.isConnected || props.suspended) return;
								const target = props.initialFocus?.();
								if (target === initialTarget) return;
								target?.focus();
								if (!content.contains(document.activeElement)) content.focus();
							});
						}
					})
				}
				onCloseAutoFocus={(event) => {
					// Respect a newer focus owner (e.g. close-and-open in one turn).
					if (event.defaultPrevented) return;
					event.preventDefault();
					const target = returnFocus?.isConnected
						? returnFocus
						: props.fallbackFocus?.();
					target?.focus();
					returnFocus = undefined;
				}}
				onEscapeKeyDown={(event) => {
					event.preventDefault();
					// A legacy child can remove itself and clear suspension in
					// Solid's delegated handler before this document listener runs.
					// Use the event's original surface, not the new open state.
					if (
						!(event.target instanceof Element) ||
						event.target.closest('[role="dialog"], [role="alertdialog"]') !==
							content
					)
						return;
					event.stopPropagation();
					close();
				}}
				onInteractOutside={(event) => event.preventDefault()}
				onFocusOutside={(event) => {
					if (props.suspended) return;
					const target = event.target;
					if (
						target instanceof Element &&
						target.closest('[aria-modal="true"]')
					)
						return;
					// Kobalte excludes its nested layers before invoking this hook.
					// Its last-focused control can become disabled while pending,
					// so retain a focusable-surface fallback for that case.
					props.initialFocus?.()?.focus();
					if (!content?.contains(document.activeElement)) content?.focus();
				}}
				onKeyDown={(event: KeyboardEvent) => {
					// Handle boundary navigation directly; Kobalte additionally
					// contains pointer/programmatic focus and stacks nested scopes.
					if (
						event.key === "Tab" &&
						!event.defaultPrevented &&
						!props.suspended &&
						content &&
						event.target instanceof Element &&
						event.target.closest('[role="dialog"]') === content
					)
						trapTabKey(content, event);
					// Solid delegates through owners before Kobalte's
					// document Escape listener. Stop an old parent dialog here;
					// Kobalte still decides which dismissable layer owns Escape.
					if (event.key === "Escape") event.stopPropagation();
					props.onKeyDown?.(event);
				}}
				onClick={(event: MouseEvent) => {
					if (
						event.target !== event.currentTarget ||
						props.suspended ||
						props.dismissible === false
					)
						return;
					if (props.onBackdropClick) props.onBackdropClick(event);
					else close();
				}}
			>
				{/* Kobalte inserts focus sentinels into Content. Give Solid's
				    dynamic child reconciliation its own stable parent so a sole
				    Show/Switch does not retain old panels beside those sentinels. */}
				<div class="contents">{props.children}</div>
			</Dialog.Content>
		</Dialog>
	);
}
