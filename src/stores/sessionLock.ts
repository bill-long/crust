let held = 0;

/** Whether this document owns the lock, including reads during a transaction. */
export function isSessionLockHeld(): boolean {
	return held > 0;
}

/** All production read/modify/write operations on the session key share this lock. */
export async function withSessionLock<T>(
	operation: () => T | Promise<T>,
): Promise<T> {
	if (!navigator.locks) {
		// Old contexts can keep using an existing account, but persistLogin
		// refuses to mint a stored login without cross-window coordination.
		return operation();
	}
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error("Another tab is busy saving account changes. Try again."),
			),
		5_000,
	);
	try {
		return await navigator.locks.request(
			"crust:session",
			{ signal: controller.signal },
			async () => {
				// The deadline bounds acquisition, not work performed under the lock.
				clearTimeout(timer);
				held++;
				try {
					return await operation();
				} finally {
					held--;
				}
			},
		);
	} finally {
		// Includes rejected requests and synchronous request() failures.
		clearTimeout(timer);
	}
}
