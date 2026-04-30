import {
	createContext,
	createResource,
	type ParentComponent,
	Show,
	useContext,
} from "solid-js";
import type { CrustConfig } from "../types/config";

const ConfigContext = createContext<CrustConfig>();

async function fetchConfig(): Promise<CrustConfig> {
	const res = await fetch("/config.json");
	if (!res.ok) throw new Error("Failed to load config.json");
	return res.json();
}

export const ConfigProvider: ParentComponent = (props) => {
	const [config] = createResource(fetchConfig);

	return (
		<Show
			when={!config.error}
			fallback={
				<div class="flex h-screen items-center justify-center bg-neutral-950">
					<div class="text-center">
						<p class="text-red-400">Failed to load configuration</p>
						<p class="mt-1 text-sm text-neutral-500">
							Check that config.json is accessible and try refreshing.
						</p>
					</div>
				</div>
			}
		>
			<Show
				when={config()}
				fallback={
					<div class="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400">
						Loading…
					</div>
				}
			>
				{(cfg) => (
					<ConfigContext.Provider value={cfg()}>
						{props.children}
					</ConfigContext.Provider>
				)}
			</Show>
		</Show>
	);
};

export function useConfig(): CrustConfig {
	const ctx = useContext(ConfigContext);
	if (!ctx) throw new Error("useConfig must be used within ConfigProvider");
	return ctx;
}
