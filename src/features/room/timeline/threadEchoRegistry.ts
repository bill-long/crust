import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";

/**
 * Session-lived registries of pending thread echoes, keyed per client
 * (WeakMap, so a logout's discarded client releases its events) and then
 * per `${roomId}|${source.key}` scope. Module-level on purpose: the hook
 * instance unmounts with the thread panel, and a FAILED thread send held
 * only in hook state would silently become unretryable (thread echoes
 * exist in no SDK timeline, unlike main-timeline pending events).
 */
const threadEchoRegistries = new WeakMap<
	MatrixClient,
	Map<string, Map<string, MatrixEvent>>
>();

export function getThreadEchoRegistry(
	client: MatrixClient,
	roomId: string,
	sourceKey: string,
): Map<string, MatrixEvent> {
	let byScope = threadEchoRegistries.get(client);
	if (!byScope) {
		byScope = new Map();
		threadEchoRegistries.set(client, byScope);
	}
	const scope = `${roomId}|${sourceKey}`;
	let registry = byScope.get(scope);
	if (!registry) {
		registry = new Map();
		byScope.set(scope, registry);
	}
	return registry;
}

/**
 * Drop a scope's registry once it holds nothing, so the client-lifetime
 * module registry stays proportional to threads with actually-pending
 * sends instead of accreting one empty Map per thread ever composed in.
 * Called only when the scope is being swapped out or the hook disposes -
 * never while the scope is active, so the live reference can't be
 * orphaned from the module map.
 */
export function releaseThreadEchoRegistryIfEmpty(
	client: MatrixClient,
	roomId: string | null,
	sourceKey: string | null,
): void {
	if (!roomId || !sourceKey) return;
	const byScope = threadEchoRegistries.get(client);
	if (!byScope) return;
	const scope = `${roomId}|${sourceKey}`;
	if (byScope.get(scope)?.size === 0) byScope.delete(scope);
}
