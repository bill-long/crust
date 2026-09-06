import {
	AuthType,
	ClientPrefix,
	type MatrixClient,
	Method,
} from "matrix-js-sdk";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth";
import { type Accessor, createSignal } from "solid-js";
import {
	ACCOUNT_MANAGEMENT_ACTIONS,
	type AccountManagementAction,
	type AccountManagementDeeplinkOptions,
	fetchAccountManagementUrl,
} from "../../client/accountManagement";
import {
	OAUTH_STAGE_ALIAS,
	parseUia401,
	passwordAuthDict,
	pickUiaRoute,
	type Uia401,
	webUrlOrNull,
} from "../../lib/uia";

/**
 * What the user must be asked for so the current UIA dance can continue.
 * Null between prompts (the dialog shows its own working state).
 */
export type UiaPrompt =
	| {
			kind: "password";
			/** Set when a previous attempt was refused (wrong password). */
			error?: string;
	  }
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

/**
 * The approval-page URL the server put in the 401's stage params
 * (`params["m.oauth"].url`, or the pre-MSC4312 alias). Scheme-pinned to
 * web URLs like every other server-supplied link we navigate to.
 */
function oauthUrlFromParams(params: Record<string, unknown>): string | null {
	for (const stage of [AuthType.OAuth as string, OAUTH_STAGE_ALIAS]) {
		const url = webUrlOrNull(
			(params[stage] as { url?: unknown } | undefined)?.url,
		);
		if (url) return url;
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
	 * and its onCleanup. The abort is sticky for the rest of the flow's
	 * life: preflight() clears it to start a fresh attempt, so a flow used
	 * WITHOUT preflight has no way back and its dialog must treat a cancel
	 * as terminal (close, and build a new flow if reopened).
	 *
	 * Deliberately scoped to waiting-for-input states: an operation whose
	 * challenge preflight already collected finishes even if the dialog
	 * goes away mid-flight. Aborting it at the UIA stage instead would
	 * strand `resetEncryption` half-done AFTER its teardown of backups and
	 * secret storage - completing user-confirmed destructive work beats
	 * abandoning it partway. The dialogs' disposed guard is what prevents
	 * an operation from ever STARTING without a UI.
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
	 *
	 * Known limit: a server that skips UIA for the no-op empty upload but
	 * challenges the real key-replacing one (possible under MSC3967
	 * semantics) defeats the early collection - the flow then degrades to
	 * the interactive mid-operation prompt in {@link uiaCallback}, honest
	 * but after resetEncryption's teardown. Continuwuity, the target
	 * server, challenges the empty upload too (wire-verified).
	 */
	preflight: () => Promise<void>;
	/**
	 * Pass as `authUploadDeviceSigningKeys` (or any UIAuthCallback slot).
	 * Tries the request unauthenticated first, then satisfies the 401.
	 *
	 * A password preflight already collected and verified is submitted
	 * once, and a refusal propagates - it cannot be a typo, so re-asking
	 * would only obscure the real failure. A password this callback has to
	 * collect itself (no preflight ran) re-prompts on refusal instead,
	 * exactly as preflight does when IT collects. An `m.oauth` stage
	 * re-prompts only while the server still refuses the approval (not
	 * granted yet, or expired).
	 */
	uiaCallback: UIAuthCallback<void>;
}

/** Tuning for one {@link createUiaFlow} instance. */
export interface UiaFlowOptions {
	/**
	 * Which account-management action the approval deeplink points at when
	 * a 401 carries no URL of its own. Defaults to the cross-signing reset
	 * the signing-key operations need; a device sign-out passes
	 * `deviceDelete` plus the device it is revoking (#556). Sending the
	 * user to the wrong action's page is a real dead end, so any operation
	 * that isn't a signing-key upload must set this.
	 */
	deeplink?: {
		action: AccountManagementAction;
	} & AccountManagementDeeplinkOptions;
}

/**
 * Interactive UIA driver (#467). The server decides which confirmation UI
 * the user sees - password sessions get the password prompt, OAuth
 * sessions (whose 401 advertises the `m.oauth` stage instead) get a
 * deeplink to the account-management page.
 *
 * Two halves that are used independently. {@link UiaFlow.preflight} is
 * only for operations that destroy something BEFORE their UIA-gated
 * request (`resetEncryption`); its probe posts to the signing-key
 * endpoint, so an operation with no such window - a device sign-out,
 * whose unauthenticated attempt IS the discovery - uses
 * {@link UiaFlow.uiaCallback} alone and must not call it.
 */
export function createUiaFlow(
	client: MatrixClient,
	options?: UiaFlowOptions,
): UiaFlow {
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
	 * URL of its own. Defaults to the cross-signing-reset action, which is
	 * right for both signing-key dialogs: MSC2965 defines no setup action,
	 * and the server gates any signing-key upload behind this same
	 * approval. Other operations override it via {@link UiaFlowOptions}.
	 */
	// Fetched at most once per flow - a server without an
	// account-management page must not pay a guaranteed-null round-trip on
	// every refusal re-prompt.
	let metadataUrl: Promise<string | null> | null = null;
	const metadataDeeplink = (): Promise<string | null> => {
		const { action, ...opts } = options?.deeplink ?? {
			action: ACCOUNT_MANAGEMENT_ACTIONS.crossSigningReset,
		};
		metadataUrl =
			metadataUrl ?? fetchAccountManagementUrl(client, action, opts);
		return metadataUrl;
	};

	/**
	 * Empty upload to the signing-key endpoint: a no-op on servers that
	 * allow it, the UIA challenge teller on servers that don't, and (with
	 * `auth`) a non-destructive way to verify a collected password. Posted
	 * to the same v3 route the SDK's real upload uses - the SDK's
	 * uploadDeviceSigningKeys helper still posts to the unstable prefix,
	 * whose UIA policy could differ.
	 */
	const probe = (auth?: object): Promise<unknown> =>
		client.http.authedRequest(
			Method.Post,
			"/keys/device_signing/upload",
			undefined,
			auth ? { auth } : {},
			{ prefix: ClientPrefix.V3 },
		);

	const preflight = async (): Promise<void> => {
		aborted = false;
		learned = null;
		let uia: Uia401;
		try {
			await probe();
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
		const route = pickUiaRoute(uia.flows);
		if (!route) throw new Error(NO_SUPPORTED_FLOW_MESSAGE);
		if (route.kind === "password") {
			// Verify the password against the probe's session before the
			// operation runs: a typo must fail HERE, while the account is
			// still untouched, not after a destructive teardown. Wrong
			// entries re-prompt.
			let error: string | undefined;
			for (;;) {
				const password =
					(await ask({
						kind: "password",
						...(error !== undefined ? { error } : {}),
					})) ?? "";
				try {
					await probe(
						passwordAuthDict(client.getUserId() ?? "", password, uia.session),
					);
					learned = { kind: "password", password };
					return;
				} catch (e) {
					const retry = parseUia401(e);
					if (!retry) throw e;
					uia.session = retry.session;
					error = "Incorrect password. Try again.";
				}
			}
		}
		// The oauth approval is NOT verified here: the server's ticket is
		// one-consume, and spending it on the probe would leave none for
		// the operation itself. The callback's refusal loop covers a
		// not-actually-approved confirmation.
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

		const route = pickUiaRoute(uia.flows);
		if (!route) throw new Error(NO_SUPPORTED_FLOW_MESSAGE);

		if (route.kind === "password") {
			if (learned?.kind === "password") {
				// preflight already collected AND verified this password against
				// a probe session, so a refusal here is not a typo - it is a
				// real failure the dialog's error step must report, not
				// something to re-ask about.
				await makeRequest(
					passwordAuthDict(
						client.getUserId() ?? "",
						learned.password,
						uia.session,
					),
				);
				return;
			}
			// No preflight (an operation with no destructive window before
			// its UIA, e.g. a device sign-out): this callback is where the
			// password is collected, so it is also where a typo re-prompts -
			// the same loop preflight runs when IT does the collecting.
			let error: string | undefined;
			for (;;) {
				const password =
					(await ask({
						kind: "password",
						...(error !== undefined ? { error } : {}),
					})) ?? "";
				try {
					await makeRequest(
						passwordAuthDict(client.getUserId() ?? "", password, uia.session),
					);
					return;
				} catch (e) {
					const retry = parseUia401(e);
					if (!retry) throw e;
					// Retry against whatever session the refusal names rather
					// than the one we sent: Continuwuity echoes the same one
					// (wire-verified on both device routes), but a server that
					// rotates it would turn a resubmit against the stale one
					// into a different, confusing failure.
					uia.session = retry.session;
					error = "Incorrect password. Try again.";
				}
			}
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
