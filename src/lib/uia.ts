import { AuthType } from "matrix-js-sdk";

/**
 * Framework-free helpers for Matrix User-Interactive Authentication
 * challenges, shared by the crypto UIA flow (`features/crypto/uiaFlow.ts`)
 * and the account-security calls (`client/accountSecurity.ts`).
 */

/** Pre-MSC4312 name for the `m.oauth` stage, still sent by some servers. */
export const OAUTH_STAGE_ALIAS = "org.matrix.cross_signing_reset";

/** The fields of a UIA 401 body Crust reads. */
export interface Uia401 {
	session: string;
	/** Each entry is one flow's ordered stage list. */
	flows: string[][];
	params: Record<string, unknown>;
}

/**
 * Parse an SDK request error as a UIA challenge. Null for anything that
 * isn't a 401 carrying a UIA session - those are real failures the caller
 * rethrows.
 */
export function parseUia401(e: unknown): Uia401 | null {
	const err = e as {
		httpStatus?: number;
		data?: { session?: unknown; flows?: unknown; params?: unknown };
	};
	if (err?.httpStatus !== 401 || typeof err.data?.session !== "string") {
		return null;
	}
	const flows: string[][] = [];
	if (Array.isArray(err.data.flows)) {
		for (const flow of err.data.flows) {
			const flowStages = (flow as { stages?: unknown })?.stages;
			if (Array.isArray(flowStages)) {
				flows.push(
					flowStages.filter((s): s is string => typeof s === "string"),
				);
			}
		}
	}
	const params =
		typeof err.data.params === "object" && err.data.params !== null
			? (err.data.params as Record<string, unknown>)
			: {};
	return { session: err.data.session, flows, params };
}

export type UiaRoute =
	| { kind: "password" }
	| {
			kind: "oauth";
			/** The stage name the server advertised - echoed back on submit,
			 *  so a pre-MSC4312 server isn't sent a name it doesn't know. */
			stage: string;
	  };

/**
 * Which advertised flow this client can complete. Only single-stage flows
 * are completable (there is no UI for chaining stages); password wins when
 * both are offered because it stays in-app.
 */
export function pickUiaRoute(flows: string[][]): UiaRoute | null {
	const single = flows.filter((f) => f.length === 1).map((f) => f[0]);
	if (single.includes(AuthType.Password)) return { kind: "password" };
	const oauthStage = single.find(
		(s) => s === (AuthType.OAuth as string) || s === OAUTH_STAGE_ALIAS,
	);
	if (oauthStage) return { kind: "oauth", stage: oauthStage };
	return null;
}

/**
 * `uri` when it parses as a web (http/https) URL, else null. The single
 * definition of the scheme pin for server-supplied URLs we navigate to -
 * anything else (javascript:, ipc:, ...) must never reach an href.
 */
export function webUrlOrNull(uri: unknown): string | null {
	if (typeof uri !== "string" || !uri) return null;
	try {
		const parsed = new URL(uri);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? uri
			: null;
	} catch {
		return null;
	}
}

/** The auth dict completing an `m.login.password` stage. */
export function passwordAuthDict(
	userId: string,
	password: string,
	session: string,
): {
	type: AuthType.Password;
	identifier: { type: "m.id.user"; user: string };
	password: string;
	session: string;
} {
	return {
		type: AuthType.Password,
		identifier: { type: "m.id.user", user: userId },
		password,
		session,
	};
}
