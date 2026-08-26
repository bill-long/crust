/**
 * Minimal get/set/delete surface shared by `Map` and `WeakMap`, so chains
 * can be keyed by plain values (room ids) or by objects (a MatrixClient,
 * where WeakMap keying lets a logged-out client's state be collected).
 */
interface ChainStore<K> {
	get(key: K): Promise<void> | undefined;
	set(key: K, value: Promise<void>): unknown;
	delete(key: K): unknown;
}

/**
 * Append `task` to the per-key promise chain in `chains`, serializing
 * writes that must not commit out of order (e.g. opposite-value PUTs to
 * one account-data key, or read-modify-write cycles over a shared map).
 *
 * Invariants, in one place for every caller:
 * - An idle chain runs `task` synchronously, so an optimistic UI flip and
 *   its request start in the same task.
 * - A rejected task neither blocks later writes nor surfaces as an
 *   unhandled rejection; the caller of THAT task owns its error handling
 *   via the returned promise.
 * - The stored tail is dropped once it settles (when still current), so
 *   the store doesn't retain every key ever touched.
 */
export function enqueueKeyedWrite<K>(
	chains: ChainStore<K>,
	key: K,
	task: () => Promise<void>,
): Promise<void> {
	const pending = chains.get(key);
	let next: Promise<void>;
	if (pending) {
		next = pending.then(task);
	} else {
		// Run synchronously, but convert a synchronous throw into a
		// rejection so both arms honor the same contract (the caller's
		// .catch sees every failure, and the chain bookkeeping still runs).
		try {
			next = task();
		} catch (err) {
			next = Promise.reject(err);
		}
	}
	const stored = next.catch(() => {});
	chains.set(key, stored);
	stored.then(() => {
		if (chains.get(key) === stored) chains.delete(key);
	});
	return next;
}
