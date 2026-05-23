import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vite";
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
	plugins: [solid(), tailwindcss()],
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
