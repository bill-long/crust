import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { type Component, onCleanup, Show } from "solid-js";

interface ComposerPlusMenuProps {
	/** Voice recording is supported in this environment (static per session). */
	voiceSupported: boolean;
	/** True when composing in a thread - hides the event item (its dialog
	 *  picks a target room, which conflicts with a thread scope). Polls
	 *  are thread-capable (#332) and stay visible. */
	inThread: boolean;
	/** Make the trigger inert (the recording bar overlays the input area, and
	 *  the button must not be reachable underneath). */
	inert?: boolean;
	/** Start a voice recording. */
	onStartRecording: () => void;
	/** Open the poll dialog (and close the pickers). */
	onOpenPoll: () => void;
	/** Open the event dialog (and close the pickers). */
	onOpenEvent: () => void;
	/** Files chosen via the hidden attach input. */
	onFileSelected: (e: Event & { currentTarget: HTMLInputElement }) => void;
	/** The menu just opened. The composer closes its GIF/emoji picker
	 *  popovers here, mirroring how the old strip buttons closed sibling
	 *  pickers on click - a picker left open would float under/over the
	 *  menu (z-20 vs the portaled z-50) as a confusing double-popover. */
	onOpen: () => void;
	/** Report the measured trigger width so the composer can reserve exactly
	 *  this much textarea padding (same contract as the action strip). */
	onMeasure: (width: number) => void;
}

/**
 * The Discord-style "+" menu anchored to the bottom-left of the textarea:
 * one trigger button that drops up a menu with the less-frequent composer
 * actions (attach, poll, event, voice), keeping the strip on the right down
 * to just the GIF and emoji pickers.
 *
 * Purely presentational: the composer owns the dialogs, the recorder, and the
 * file queue; the menu only triggers callbacks. The hidden file input lives
 * here but OUTSIDE the portaled menu content, so out-of-menu entry points
 * (tests, programmatic dispatch) can always reach it in the DOM.
 */
const ComposerPlusMenu: Component<ComposerPlusMenuProps> = (props) => {
	let fileInputRef: HTMLInputElement | undefined;
	let triggerRef: HTMLButtonElement | undefined;

	return (
		<div
			ref={(el) => {
				// Same deferred-measure pattern as ComposerActionStrip: writing
				// the padding inside the observer callback perturbs layout in the
				// same frame and trips the browser's "ResizeObserver loop" error.
				let raf = 0;
				const observer = new ResizeObserver(() => {
					cancelAnimationFrame(raf);
					raf = requestAnimationFrame(() => props.onMeasure(el.offsetWidth));
				});
				observer.observe(el);
				onCleanup(() => {
					cancelAnimationFrame(raf);
					observer.disconnect();
				});
			}}
			inert={props.inert || undefined}
			class="absolute bottom-2.5 left-2 flex items-center"
		>
			{/* Hidden attach input. Accepts images and arbitrary files; non-media
			    files are classified as m.file at send. */}
			<input
				ref={(el) => {
					fileInputRef = el;
				}}
				type="file"
				multiple
				data-composer-file-input
				class="hidden"
				onChange={props.onFileSelected}
			/>
			{/* Non-modal: Kobalte's modal menus trap focus until fully closed,
			    and the close is deferred a tick after onSelect - so a dialog
			    opened from an item would have its initial focus yanked back
			    into the dying menu, landing on the trigger with the modal
			    dialog open. Non-modal keeps Escape/outside-click dismissal and
			    arrow-key item nav, without the trap. */}
			<DropdownMenu
				modal={false}
				placement="top-start"
				gutter={8}
				onOpenChange={(open) => {
					if (open) props.onOpen();
				}}
			>
				{/* "Message actions", not "More actions": the room header's
				    overflow button already owns that name (RoomPane), and two
				    identically named menus in one view are indistinguishable
				    in a screen-reader element list. */}
				<DropdownMenu.Trigger
					ref={(el: HTMLButtonElement) => {
						triggerRef = el;
					}}
					class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover data-expanded:bg-surface-3 data-expanded:text-text-secondary"
					aria-label="Message actions"
				>
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
						<circle cx="12" cy="12" r="10" />
						<path d="M8 12h8" />
						<path d="M12 8v8" />
					</svg>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					{/* Deterministic close restore: Kobalte restores focus to
					    whatever was focused when the menu MOUNTED, but opening
					    over a picker snapshots a picker input that onOpen then
					    unmounts - Escape would silently drop focus to <body>.
					    Focus the trigger instead. When the event arrives already
					    defaultPrevented, focus has legitimately moved on (the
					    poll/event dialogs, the voice recording bar) - leave it. */}
					<DropdownMenu.Content
						onCloseAutoFocus={(e) => {
							if (e.defaultPrevented) return;
							e.preventDefault();
							triggerRef?.focus();
						}}
						class="z-50 min-w-[180px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg"
					>
						<DropdownMenu.Item
							class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:outline-none"
							onSelect={() => fileInputRef?.click()}
						>
							{/* Inline paperclip, replacing the paperclip emoji (which reads
							    as Clippy on some platforms and renders inconsistently). */}
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
								<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
							</svg>
							Attach file
						</DropdownMenu.Item>
						{/* Poll/event items are new sends, so they never show while
						    editing (the whole menu is hidden then). The poll item is
						    available in threads too (#332): the dialog sends into the
						    thread via the SDK's thread overload. aria-haspopup carried
						    over from the old strip buttons: these items open modal
						    dialogs, not immediate actions. */}
						<DropdownMenu.Item
							class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:outline-none"
							aria-haspopup="dialog"
							onSelect={() => props.onOpenPoll()}
						>
							<svg
								class="h-4 w-4 shrink-0"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								aria-hidden="true"
							>
								<path d="M6 20V10" />
								<path d="M12 20V4" />
								<path d="M18 20v-6" />
							</svg>
							Create poll
						</DropdownMenu.Item>
						{/* Event cards stay main-timeline-only: CreateEventDialog
						    picks a TARGET room, which has no coherent meaning inside
						    a thread scope. */}
						<Show when={!props.inThread}>
							<DropdownMenu.Item
								class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:outline-none"
								aria-haspopup="dialog"
								onSelect={() => props.onOpenEvent()}
							>
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
									<rect x="3" y="4" width="18" height="18" rx="2" />
									<path d="M16 2v4" />
									<path d="M8 2v4" />
									<path d="M3 10h18" />
								</svg>
								Create event
							</DropdownMenu.Item>
						</Show>
						<Show when={props.voiceSupported}>
							<DropdownMenu.Item
								class="flex min-h-11 cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:outline-none"
								onSelect={() => props.onStartRecording()}
							>
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
									<rect x="9" y="2" width="6" height="12" rx="3" />
									<path d="M5 10v1a7 7 0 0 0 14 0v-1" />
									<path d="M12 18v4" />
								</svg>
								Record voice message
							</DropdownMenu.Item>
						</Show>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu>
		</div>
	);
};

export { ComposerPlusMenu };
