import {
	createContext,
	createResource,
	type ParentComponent,
	Show,
	useContext,
} from "solid-js";
import type { CrustConfig } from "../types/config";
import { normalizeConfig } from "../types/config";

const ConfigContext = createContext<CrustConfig>();

async function fetchConfig(): Promise<CrustConfig> {
	const res = await fetch("/config.json");
	if (!res.ok) throw new Error("Failed to load config.json");
	const raw = await res.json();
	return normalizeConfig(raw);
}

export const ConfigProvider: ParentComponent = (props) => {
	const [config] = createResource(fetchConfig);

	return (
		<Show
			when={!config.error}
			fallback={
				<div class="flex h-full items-center justify-center bg-surface-0">
					<div class="text-center">
						<p class="text-danger-text">Failed to load configuration</p>
						<p class="mt-1 text-sm text-text-disabled">
							Check that config.json is accessible and try refreshing.
						</p>
					</div>
				</div>
			}
		>
			<Show
				when={config()}
				fallback={
					<div class="flex h-full items-center justify-center bg-surface-0 text-text-muted">
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
