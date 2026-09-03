import { execFileSync } from "node:child_process";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { appendDevCspSources } from "./scripts/csp-lib.mjs";
import { ensureDevCert } from "./scripts/dev-https-lib.mjs";
import { ICON_FILENAMES } from "./src/lib/iconRuntimeCache";

// Public base path the app is served from. Override with VITE_BASE_PATH
// at build time (e.g. `VITE_BASE_PATH=/crust/ pnpm build`) to host the
// app under a sub-path like https://example.com/crust/. Must start and
// end with `/`. The default `/` builds a root-hosted SPA.
const basePath = process.env.VITE_BASE_PATH ?? "/";
if (!basePath.startsWith("/") || !basePath.endsWith("/")) {
	throw new Error(
		`VITE_BASE_PATH must start and end with "/" (got ${JSON.stringify(basePath)}); ` +
			`for example "/crust/".`,
	);
}

// The webmanifest icons, defined once and reused for both the manifest and a
// coverage assertion. Every entry must be in ICON_FILENAMES; otherwise a
// manifest icon that isn't in that list is neither excluded from the precache
// (globIgnores is derived from ICON_FILENAMES) nor served by the runtime icon
// route - so the glob scan would precache it and it would go stale under the
// non-skipWaiting SW, reintroducing #252. Fail the build loudly rather than ship
// that drift.
const manifestIcons = [
	{ src: "pwa-192.png", sizes: "192x192", type: "image/png" },
	{ src: "pwa-512.png", sizes: "512x512", type: "image/png" },
	{
		src: "pwa-maskable-512.png",
		sizes: "512x512",
		type: "image/png",
		purpose: "maskable",
	},
] as const;
for (const icon of manifestIcons) {
	if (!(ICON_FILENAMES as readonly string[]).includes(icon.src)) {
		throw new Error(
			`Webmanifest icon "${icon.src}" is not in ICON_FILENAMES ` +
				`(src/lib/iconRuntimeCache.ts); add it there so it is excluded from ` +
				`the precache and served by the runtime icon route. See issue #252.`,
		);
	}
}

// Dev-only CSP tweak (issue #314): the baseline CSP meta tag in index.html is
// the single source of truth and applies in dev too, but dev needs sources
// production must not allow - the HMR websocket (ws:) and http loopback
// endpoints (local homeserver / Element Call). The extras live in
// DEV_EXTRA_SOURCES (scripts/csp-lib.mjs), shared with the tauri devCsp
// check so browser dev and desktop dev cannot drift apart. Production
// builds keep the untouched baseline.
const devCsp = (): Plugin => ({
	name: "crust:dev-csp",
	apply: "serve",
	transformIndexHtml(html) {
		// Only the app shell carries the CSP meta tag; other served pages
		// (e.g. Vitest browser-mode tester pages) pass through untouched.
		// index.html losing the tag entirely is caught by check-csp-sync.
		if (!/<meta\s[^>]*http-equiv="Content-Security-Policy"/i.test(html)) {
			return html;
		}
		return appendDevCspSources(html);
	},
});

export default defineConfig(({ command, mode, isPreview }) => ({
	base: basePath,
	// `pnpm dev:https` is `vite --mode https` (#468): the dev server over TLS
	// with a self-signed localhost certificate kept in .dev-certs/, because
	// Continuwuity rejects an OAuth client_uri that is not https and the
	// OAuth login flow cannot be exercised otherwise. Gated on the dev server
	// proper: `vite build --mode https` never touches it, and neither does
	// `vite preview`, which also runs as the serve command. The pair is named
	// `*.pem` so Vite's stock `server.fs.deny` refuses to serve it; that list
	// is not extended here because setting `fs.deny` replaces the defaults,
	// and the default is the rule that matters.
	server:
		command === "serve" && !isPreview && mode === "https"
			? {
					https: ensureDevCert(join(import.meta.dirname, ".dev-certs"), {
						run: (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" }),
					}),
				}
			: undefined,
	build: {
		rolldownOptions: {
			output: {
				// Vendor chunking (#307): split the two heaviest dependencies out of
				// the app chunk so they cache independently across deploys - app
				// code changes every release, matrix-js-sdk and Kobalte change only
				// on dependency bumps, so returning users re-download a small app
				// chunk instead of the whole bundle. Groups are evaluated in
				// priority order; matrix-js-sdk must win over the catch-all
				// node_modules group for its own packages. The crypto wasm bindings
				// belong with the SDK: it is what loads them, and the app's own
				// import (src/client/client.tsx, the module-load step of crypto
				// recovery) must not pull them into the app chunk.
				advancedChunks: {
					groups: [
						{
							name: "matrix-js-sdk",
							test: /node_modules[\\/](matrix-js-sdk|@matrix-org[\\/]matrix-sdk-crypto-wasm)/,
							priority: 20,
						},
						{
							name: "kobalte",
							test: /node_modules[\\/]@kobalte/,
							priority: 10,
						},
					],
				},
			},
		},
	},
	plugins: [
		devCsp(),
		solid(),
		tailwindcss(),
		VitePWA({
			strategies: "injectManifest",
			srcDir: "src",
			filename: "sw.ts",
			registerType: "prompt",
			injectRegister: "auto",
			// Don't auto-add the webmanifest icons to the precache: they're the
			// same stable-named pwa-*.png assets we deliberately keep out of the
			// precache (globIgnores below) and serve via the runtime icon route
			// in src/sw.ts, so a changed icon isn't pinned stale by the
			// non-skipWaiting SW. Without this, includeManifestIcons (default true)
			// would precache them anyway. See issue #252.
			includeManifestIcons: false,
			manifest: {
				name: "Crust",
				short_name: "Crust",
				description: "A fast, Discord-class Matrix chat client.",
				// Dark title-bar color (surface-1) so the installed-app title
				// bar's auto-chosen text stays readable, focused or unfocused.
				// The brand pink is the in-app accent, not the OS chrome color.
				theme_color: "#171717",
				background_color: "#0a0a0a",
				display: "standalone",
				// Honor the configurable base path (default "/", e.g. "/crust/").
				scope: basePath,
				start_url: basePath,
				// Cast off the readonly literal type; VitePWA's manifest.icons
				// expects a mutable array. Coverage over ICON_FILENAMES is asserted
				// above (see manifestIcons).
				icons: [...manifestIcons],
			},
			injectManifest: {
				// The ~8 MB crypto wasm is deliberately NOT precached: that would
				// cost every visitor the download at worker install. A shell served
				// from an older worker's precache after a deploy still finds its wasm
				// in the browser's HTTP cache (hashed assets ship with a year-long
				// max-age); if it does not, crypto recovery reloads once and then
				// shows the banner next to the "App update" card - never a wipe (see
				// src/client/cryptoRecovery.ts). The desktop shell's worker precaches
				// nothing at all (#481).
				globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
				globIgnores: [
					// Runtime operator config must never be served stale from cache.
					"**/config.json",
					// The stable-named PWA icons/favicon are served via the runtime
					// icon route in src/sw.ts instead of being precached, so an icon
					// change propagates on the next normal refresh rather than waiting
					// for the non-skipWaiting SW to fully take over. Derived from
					// ICON_FILENAMES so this exclusion can never drift from what the
					// runtime route caches. Matched by basename (`**/`), which is safe
					// because these live only in public/ (emitted to the dist root) and
					// every bundled asset is content-hashed, so nothing else shares
					// these exact names. See issue #252.
					...ICON_FILENAMES.map((name) => `**/${name}`),
				],
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
			},
			// Keep the dev server free of a registered service worker; the PWA is
			// only active in production builds.
			devOptions: { enabled: false },
		}),
	],
	test: {
		globals: true,
		server: {
			deps: {
				// matrix-js-sdk 42.x's built artifacts contain extensionless
				// directory imports (`from "../http-api"` in lib/oauth/*), which
				// native Node ESM rejects. Inline the package so vitest resolves
				// it through Vite's resolver, like the app build does.
				inline: ["matrix-js-sdk"],
			},
		},
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					environment: "jsdom",
					// scripts/: node-side build/check helpers (e.g. csp-lib) keep
					// their tests next to the code; they run fine under jsdom.
					include: ["src/**/*.test.{ts,tsx}", "scripts/*.test.mjs"],
					exclude: ["src/**/*.browser.test.{ts,tsx}"],
				},
			},
			{
				extends: true,
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.{ts,tsx}"],
					setupFiles: ["src/test/browserSetup.ts"],
					browser: {
						enabled: true,
						provider: playwright({
							launchOptions: {
								// Realtime AudioContexts otherwise stay suspended
								// (resume() waits for a user gesture the harness never
								// makes), flatlining Web Audio tests like the voice
								// recorder's analyser.
								args: ["--autoplay-policy=no-user-gesture-required"],
							},
						}),
						headless: true,
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
}));
