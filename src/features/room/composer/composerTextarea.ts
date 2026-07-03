/**
 * One composer instance exists per scope: the room's main composer
 * ("main") or a thread panel's composer (the thread root id). The scope
 * value is stamped on the textarea's `data-composer-textarea` attribute
 * and used by focus lookups; both sides share these helpers so the
 * scheme cannot drift between the attribute site and its consumers.
 */
export function composerTextareaScope(threadRootId?: string | null): string {
	return threadRootId ?? "main";
}

export function composerTextareaSelector(threadRootId?: string | null): string {
	return `textarea[data-composer-textarea="${composerTextareaScope(threadRootId)}"]`;
}
