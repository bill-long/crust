import { AuthType, type MatrixClient } from "matrix-js-sdk";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth";
import { type Accessor, createSignal } from "solid-js";
import {
	ACCOUNT_MANAGEMENT_ACTIONS,
	fetchAccountManagementUrl,
} from "../../client/accountManagement";

/**
 * What the user must be asked for so the current UIA dance can continue.
 * Null between prompts (the dialog shows its own working state).
 */
export type UiaPrompt =
	| { kind: "password" }
	| {
			/**
			 * The server wants out-of-band approval at its account-management
			 * page (the `m.oauth` UIA stage, MSC4312). The user opens `url`,
			 * approves there, then confirms here to continue.
			 */
			kind: "oauth";
			/** Approval page URL; null when the server advertised none. */
			url: string | null;
			/** True after a retry the server still refused - the approval
			 *  hasn't been granted (or it expired). */
			notYetApproved: boolean;
	  };

/**
 * Thrown out of {@link createUiaFlow}'s preflight/callback when the user
 * cancels a prompt, so the dialog that started the operation can step back
 * (or report the interruption) instead of rendering the abort as a
 * generic failure.
 */
export class UiaCancelledError extends Error {
	constructor() {
		super("Identity confirmation was cancelled.");
		this.name = "UiaCancelledError";
	}
}

/** Pre-MSC4312 name for the `m.oauth` stage, still sent by some servers. */
const OAUTH_STAGE_ALIAS = "org.matrix.cross_signing_reset";

/** The fields of a UIA 401 body this flow reads. */
interface Uia401 {
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
function parseUia401(e: unknown): Uia401 | null {
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

type UiaRoute =
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
function pickRoute(flows: string[][]): UiaRoute | null {
	const single = flows.filter((f) => f.length === 1).map((f) => f[0]);
	if (single.includes(AuthType.Password)) return { kind: "password" };
	const oauthStage = single.find(
		(s) => s === (AuthType.OAuth as string) || s === OAUTH_STAGE_ALIAS,
	);
	if (oauthStage) return { kind: "oauth", stage: oauthStage };
	return null;
}

/**
 * The approval-page URL the server put in the 401's stage params
 * (`params["m.oauth"].url`, or the pre-MSC4312 alias). Scheme-pinned to
 * web URLs like every other server-supplied link we navigate to.
 */
function oauthUrlFromParams(params: Record<string, unknown>): string | null {
	for (const stage of [AuthType.OAuth as string, OAUTH_STAGE_ALIAS]) {
		const url = (params[stage] as { url?: unknown } | undefined)?.url;
		if (typeof url !== "string") continue;
		try {
			const parsed = new URL(url);
			if (parsed.protocol === "https:" || parsed.protocol === "http:") {
				return url;
			}
		} catch {
			// Fall through to the next candidate / metadata fallback.
		}
	}
	return null;
}

const NO_SUPPORTED_FLOW_MESSAGE =
	"This server offers no way to confirm this action that this app supports.";

/** What {@link UiaFlow.preflight} collected from the user. */
type LearnedAuth =
	| { kind: "none" }
	| { kind: "password"; password: string }
	| { kind: "oauth"; url: string | null };

export interface UiaFlow {
	/** The prompt the dialog must render right now, or null. */
	prompt: Accessor<UiaPrompt | null>;
	/** Answer a `password` prompt. */
	submitPassword: (password: string) => void;
	/** Answer an `oauth` prompt: the user says they approved at the OP. */
	confirmOauthApproved: () => void;
	/**
	 * Abort the flow: a pending prompt rejects now, and any later prompt of
	 * the same attempt rejects immediately (so an operation suspended in a
	 * request when the dialog unmounts still settles instead of waiting on
	 * a prompt nothing will answer). Rejections carry
	 * {@link UiaCancelledError}. Call from the dialog's cancel affordances
	 * and its onCleanup; the next preflight() starts a fresh attempt.
	 */
	cancel: () => void;
	/**
	 * Learn what the server requires to upload device-signing keys and
	 * collect it from the user - a password, or out-of-band approval at
	 * the account-management page - WITHOUT performing any authenticated
	 * or destructive request (the probe is an empty unauthenticated
	 * upload). Call this BEFORE a destructive operation: cancelling here
	 * rejects with {@link UiaCancelledError} while the account is still
	 * untouched. A server that needs no auth (MSC3967 first upload)
	 * resolves without prompting; a probe failure that isn't a UIA
	 * challenge also resolves (the real operation surfaces real errors).
	 * Throws when no advertised flow is one this app can complete.
	 */
	preflight: () => Promise<void>;
	/**
	 * Pass as `authUploadDeviceSigningKeys` (or any UIAuthCallback slot).
	 * Tries the request unauthenticated first, then satisfies the 401 with
	 * what preflight collected: the password (one attempt, failures
	 * propagate), or an `m.oauth` submission - re-prompting only when the
	 * server still refuses the approval (not granted yet, or expired).
	 */
	uiaCallback: UIAuthCallback<void>;
}

/**
 * Interactive UIA driver shared by the cross-signing bootstrap and
 * encryption-reset dialogs (#467). The server decides which confirmation
 * UI the user sees - password sessions get the password prompt as before,
 * OAuth sessions (whose 401 advertises the `m.oauth` stage instead) get a
 * deeplink to the account-management page. Both operations this drives
 * upload device-signing keys, so the preflight probe targets that
 * endpoint and the metadata-deeplink fallback is pinned to the
 * cross-signing-reset action.
 */
export function createUiaFlow(client: MatrixClient): UiaFlow {
	const [prompt, setPrompt] = createSignal<UiaPrompt | null>(null);

	let pending: {
		resolve: (password?: string) => void;
		reject: (e: Error) => void;
	} | null = null;
	// Once cancelled, every later ask() of the same attempt rejects
	// immediately; preflight() resets it for the next attempt.
	let aborted = false;
	let learned: LearnedAuth | null = null;

	/** Show `p` and suspend until the dialog answers or cancels it. */
	const ask = (p: UiaPrompt): Promise<string | undefined> => {
		if (aborted) return Promise.reject(new UiaCancelledError());
		return new Promise((resolve, reject) => {
			pending = { resolve, reject };
			setPrompt(p);
		});
	};

	const answer = (password?: string): void => {
		const p = pending;
		pending = null;
		setPrompt(null);
		p?.resolve(password);
	};

	const cancel = (): void => {
		aborted = true;
		const p = pending;
		pending = null;
		setPrompt(null);
		p?.reject(new UiaCancelledError());
	};

	/**
	 * Metadata fallback for the approval deeplink when a 401 carries no
	 * URL of its own. Pinned to the cross-signing-reset action for both
	 * dialogs: MSC2965 defines no setup action, and the server gates any
	 * signing-key upload behind this same approval.
	 */
	const metadataDeeplink = (): Promise<string | null> =>
		fetchAccountManagementUrl(
			client,
			ACCOUNT_MANAGEMENT_ACTIONS.crossSigningReset,
		);

	const preflight = async (): Promise<void> => {
		aborted = false;
		learned = null;
		let uia: Uia401;
		try {
			// Empty unauthenticated upload: a no-op on servers that allow it,
			// and the UIA challenge teller on servers that don't.
			await client.uploadDeviceSigningKeys();
			learned = { kind: "none" };
			return;
		} catch (e) {
			const parsed = parseUia401(e);
			if (!parsed) {
				// Not a UIA challenge (e.g. an endpoint quirk): don't block the
				// operation on the probe - the operation reports real failures.
				learned = { kind: "none" };
				return;
			}
			uia = parsed;
		}
		const route = pickRoute(uia.flows);
		if (!route) throw new Error(NO_SUPPORTED_FLOW_MESSAGE);
		if (route.kind === "password") {
			const password = await ask({ kind: "password" });
			learned = { kind: "password", password: password ?? "" };
			return;
		}
		const url = oauthUrlFromParams(uia.params) ?? (await metadataDeeplink());
		await ask({ kind: "oauth", url, notYetApproved: false });
		learned = { kind: "oauth", url };
	};

	const uiaCallback: UIAuthCallback<void> = async (makeRequest) => {
		// Try unauthenticated first: MSC3967 servers allow the first
		// signing-key upload without UIA at all, and the 401's session is
		// what the auth submission must reference.
		let uia: Uia401;
		try {
			await makeRequest(null);
			return;
		} catch (e) {
			const parsed = parseUia401(e);
			if (!parsed) throw e;
			uia = parsed;
		}

		const route = pickRoute(uia.flows);
		if (!route) throw new Error(NO_SUPPORTED_FLOW_MESSAGE);

		if (route.kind === "password") {
			// Normally collected by preflight before the operation started;
			// ask now only if the server switched flows on us since.
			const password =
				learned?.kind === "password"
					? learned.password
					: ((await ask({ kind: "password" })) ?? "");
			// Single attempt, like the pre-#467 flow: a wrong password is a
			// real failure the dialog's error step reports.
			await makeRequest({
				type: AuthType.Password,
				identifier: { type: "m.id.user", user: client.getUserId() ?? "" },
				password,
				session: uia.session,
			});
			return;
		}

		// Approval granted during preflight: submit straight away. Re-prompt
		// only while the server keeps refusing the stage (the approval was
		// not granted after all, or its ticket expired mid-operation). The
		// operation's own 401 wins for the link; else the one preflight
		// already resolved; else one metadata fetch.
		let url =
			oauthUrlFromParams(uia.params) ??
			(learned?.kind === "oauth" ? learned.url : null);
		let approved = learned?.kind === "oauth";
		let notYetApproved = false;
		for (;;) {
			if (!approved) {
				url = url ?? (await metadataDeeplink());
				await ask({ kind: "oauth", url, notYetApproved });
			}
			approved = false;
			try {
				await makeRequest({ type: route.stage, session: uia.session });
				return;
			} catch (e) {
				const retry = parseUia401(e);
				if (!retry) throw e;
				// The refusal may rotate the session and issue a fresh
				// approval URL - use the newest of each.
				uia.session = retry.session;
				url = oauthUrlFromParams(retry.params) ?? url;
				notYetApproved = true;
			}
		}
	};

	return {
		prompt,
		submitPassword: (password) => answer(password),
		confirmOauthApproved: () => answer(),
		cancel,
		preflight,
		uiaCallback,
	};
}
