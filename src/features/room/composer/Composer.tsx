import { type Component, createSignal, Show } from "solid-js";
import { useClient } from "../../../client/client";
import { formatMarkdown } from "./markdown";

const Composer: Component<{ roomId: string }> = (props) => {
	const { client } = useClient();
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	let textareaRef: HTMLTextAreaElement | undefined;

	const autoResize = (): void => {
		const el = textareaRef;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	};

	const send = async (): Promise<void> => {
		const msg = text().trim();
		if (!msg || sending()) return;

		const { body, formatted_body } = formatMarkdown(msg);
		// Build content conforming to m.room.message / m.text
		const content = {
			msgtype: "m.text" as const,
			body,
			...(formatted_body
				? { format: "org.matrix.custom.html" as const, formatted_body }
				: {}),
		};

		const draft = text();
		setText("");
		setError(null);
		setSending(true);
		requestAnimationFrame(autoResize);

		try {
			// biome-ignore lint/suspicious/noExplicitAny: SDK's RoomMessageEventContent union is overly restrictive for simple text messages
			await client.sendMessage(props.roomId, content as any);
		} catch (e) {
			if (!text()) setText(draft);
			setError(e instanceof Error ? e.message : "Failed to send message");
			requestAnimationFrame(autoResize);
		} finally {
			setSending(false);
			if (
				!document.activeElement ||
				document.activeElement === document.body ||
				document.activeElement === textareaRef
			) {
				textareaRef?.focus();
			}
		}
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div class="border-t border-neutral-800 px-4 py-3">
			<Show when={error()}>
				<div
					class="mb-2 rounded bg-red-900/30 px-3 py-1.5 text-xs text-red-400"
					role="alert"
				>
					{error()}
				</div>
			</Show>
			<textarea
				ref={textareaRef}
				value={text()}
				onInput={(e) => {
					setText(e.currentTarget.value);
					autoResize();
				}}
				onKeyDown={onKeyDown}
				placeholder="Send a message…"
				aria-label="Message"
				class="w-full resize-none rounded-lg bg-neutral-800 px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-pink-500"
				rows={1}
			/>
		</div>
	);
};

export default Composer;
