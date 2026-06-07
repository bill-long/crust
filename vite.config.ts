import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";

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

export default defineConfig({
	base: basePath,
	plugins: [
		solid(),
		tailwindcss(),
		VitePWA({
			strategies: "injectManifest",
			srcDir: "src",
			filename: "sw.ts",
			registerType: "prompt",
			injectRegister: "auto",
			manifest: {
				name: "Crust",
				short_name: "Crust",
				description: "A fast, Discord-class Matrix chat client.",
				theme_color: "#e33e7f",
				background_color: "#0a0a0a",
				display: "standalone",
				// Honor the configurable base path (default "/", e.g. "/crust/").
				scope: basePath,
				start_url: basePath,
				icons: [
					{ src: "pwa-192.png", sizes: "192x192", type: "image/png" },
					{ src: "pwa-512.png", sizes: "512x512", type: "image/png" },
					{
						src: "pwa-maskable-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
			injectManifest: {
				globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
				// Runtime operator config must never be served stale from cache.
				globIgnores: ["**/config.json"],
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
			},
			// Keep the dev server free of a registered service worker; the PWA is
			// only active in production builds.
			devOptions: { enabled: false },
		}),
	],
	test: {
		globals: true,
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					environment: "jsdom",
					include: ["src/**/*.test.{ts,tsx}"],
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
						provider: playwright(),
						headless: true,
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
});
