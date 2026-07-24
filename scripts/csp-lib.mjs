// Shared logic for the CSP single-source-of-truth check (issue #314).
//
// The baseline Content-Security-Policy lives in the <meta> tag in index.html.
// Two other copies must stay in sync with it:
//   - docker-nginx.conf sends it as a response header (must equal the
//     baseline exactly);
//   - desktop/src-tauri/tauri.conf.json's `csp`/`devCsp` are delivered by the
//     Tauri runtime as a header ON TOP of the meta tag baked into dist/
//     index.html. Browsers enforce every delivered policy (the intersection),
//     so the Tauri copies may only ADD sources (devCsp: the DEV_EXTRA_SOURCES
//     below) - anything the baseline allows but a Tauri copy omits would be
//     silently blocked in the desktop shell. That is why the Tauri-only IPC
//     sources (`ipc:`, `http://ipc.localhost`) live in the baseline itself:
//     effectively inert on the web (see the index.html comment), but dropping
//     them from the meta tag would break desktop IPC via the intersection.
//
// Comparison is per-directive on source SETS (order-insensitive), so
// formatting differences between the copies never matter, only policy drift.

/** Parse a CSP policy string into a Map of directive name -> array of source
 *  expressions. Throws on an empty policy or a repeated directive (browsers
 *  ignore repeats, which is exactly the kind of silent drift this check
 *  exists to catch). */
export function parseCsp(policy) {
	const directives = new Map();
	for (const part of policy.split(";")) {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		const name = tokens[0].toLowerCase();
		if (directives.has(name)) {
			throw new Error(`duplicate CSP directive "${name}"`);
		}
		directives.set(name, tokens.slice(1));
	}
	if (directives.size === 0) {
		throw new Error("empty CSP policy");
	}
	return directives;
}

/** Compare a parsed policy against the parsed baseline. Every baseline
 *  directive and source must be present; extra sources are allowed only when
 *  listed in allowedExtras (directive name -> array of source expressions).
 *  Returns an array of human-readable problems (empty = in sync). */
export function comparePolicies(baseline, actual, allowedExtras = {}) {
	const problems = [];
	for (const [name, sources] of baseline) {
		const actualSources = actual.get(name);
		if (actualSources === undefined) {
			problems.push(`missing directive "${name}"`);
			continue;
		}
		const actualSet = new Set(actualSources);
		for (const source of sources) {
			if (!actualSet.has(source)) {
				problems.push(`directive "${name}" is missing source "${source}"`);
			}
		}
		const baselineSet = new Set(sources);
		const allowed = new Set(allowedExtras[name] ?? []);
		for (const source of actualSources) {
			if (!baselineSet.has(source) && !allowed.has(source)) {
				problems.push(`directive "${name}" has unexpected source "${source}"`);
			}
		}
	}
	for (const name of actual.keys()) {
		if (!baseline.has(name)) {
			problems.push(`unexpected directive "${name}"`);
		}
	}
	return problems;
}

/** Extract the baseline policy string from index.html's
 *  <meta http-equiv="Content-Security-Policy" content="..."> tag. HTML
 *  comments are stripped first (a commented-out tag must not satisfy the
 *  check) and exactly one tag must remain - a second meta policy would
 *  silently tighten the effective CSP via the intersection rule. */
export function extractHtmlCsp(html) {
	const active = html.replace(/<!--[\s\S]*?-->/g, "");
	const metas = [
		...active.matchAll(
			/<meta\s[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi,
		),
	];
	if (metas.length === 0) {
		throw new Error(
			'index.html has no <meta http-equiv="Content-Security-Policy"> tag',
		);
	}
	if (metas.length > 1) {
		throw new Error("index.html has more than one CSP meta tag");
	}
	const content = metas[0][0].match(/content="([^"]*)"/i);
	if (!content || content[1].trim() === "") {
		throw new Error("index.html CSP meta tag has no content attribute");
	}
	return content[1];
}

/** Extract the policy string from docker-nginx.conf's
 *  `add_header Content-Security-Policy "..." always;` directive. `#` comment
 *  lines are stripped first and exactly one directive must remain, for the
 *  same anti-drift reasons as extractHtmlCsp. */
export function extractNginxCsp(conf) {
	const active = conf
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
	const headers = [
		...active.matchAll(
			/add_header\s+Content-Security-Policy\s+"([^"]*)"\s+always\s*;/g,
		),
	];
	if (headers.length === 0) {
		throw new Error(
			"docker-nginx.conf has no `add_header Content-Security-Policy` directive",
		);
	}
	if (headers.length > 1) {
		throw new Error(
			"docker-nginx.conf sets the Content-Security-Policy header more than once",
		);
	}
	return headers[0][1];
}

/** Extract the `csp` and `devCsp` policy strings from tauri.conf.json. */
export function extractTauriCsps(json) {
	const config = JSON.parse(json);
	const security = config?.app?.security;
	const { csp, devCsp } = security ?? {};
	if (typeof csp !== "string" || typeof devCsp !== "string") {
		throw new Error(
			"tauri.conf.json has no app.security.csp / app.security.devCsp strings",
		);
	}
	return { csp, devCsp };
}

/** Sources dev serving adds on top of the baseline, shared by the dev-only
 *  Vite hook (vite.config.ts) and the tauri.conf.json devCsp check so the
 *  two dev policies cannot drift apart:
 *  - connect-src ws:: the Vite HMR websocket (`'self'` does not cover ws: -
 *    CSP's 'self' only matches the page scheme plus https:/wss: upgrades);
 *  - http:: the app deliberately supports plain-http loopback endpoints in
 *    development - an `http://localhost:8008` homeserver
 *    (src/features/auth/discovery.ts), a loopback Element Call url, and the
 *    media/avatars such a homeserver serves. The scheme source is the only
 *    CSP expression that can cover what the app accepts: isSecureCallUrl
 *    (src/types/config.ts) allows localhost, the whole 127.0.0.0/8 range,
 *    and [::1], and CSP's host-source grammar can express neither an IP
 *    range nor an IPv6 literal. Dev-only; production copies stay
 *    https-only. */
const DEV_HTTP = ["http:"];
export const DEV_EXTRA_SOURCES = {
	"connect-src": ["ws:", ...DEV_HTTP],
	"frame-src": DEV_HTTP,
	"img-src": DEV_HTTP,
	"media-src": DEV_HTTP,
};

/** Append the DEV_EXTRA_SOURCES to the CSP meta tag in an index.html
 *  string, returning the patched HTML. Used by the dev-only Vite hook;
 *  throws (loudly failing the dev server) if the baseline tag or one of the
 *  directives is missing. */
export function appendDevCspSources(html) {
	const policy = extractHtmlCsp(html);
	const parsed = parseCsp(policy);
	for (const [directive, sources] of Object.entries(DEV_EXTRA_SOURCES)) {
		const existing = parsed.get(directive);
		if (existing === undefined) {
			throw new Error(`baseline CSP has no "${directive}" directive to extend`);
		}
		for (const source of sources) {
			if (!existing.includes(source)) existing.push(source);
		}
	}
	const patched = [...parsed]
		.map(([name, sources]) => [name, ...sources].join(" "))
		.join("; ");
	// The exact policy string occurs once in the HTML (inside the meta tag's
	// content attribute - extractHtmlCsp guarantees the tag is unique); a
	// replacer function sidesteps `$`-pattern expansion in the replacement.
	return html.replace(policy, () => patched);
}
