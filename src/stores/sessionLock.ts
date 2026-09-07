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
	return navigator.locks.request(
		"crust:session",
		{ signal: AbortSignal.timeout(5_000) },
		async () => {
			held++;
			try {
				return await operation();
			} finally {
				held--;
			}
		},
	);
}
