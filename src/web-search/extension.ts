/** Upstream compatibility facade. The shared entrypoint imports the registration core directly. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "../config";
import { notifyConfigIssues } from "../config/notifications";
import * as upstreamRuntime from "../runtime";
import { requestAlphaSearch } from "./alpha-client";
import { createWebSearchRegistrar, executeStandaloneWebRun as executeCore } from "../compaction-extension-core";
export { createWebSearchRegistrar, _extensionTest } from "../compaction-extension-core";

const upstreamRegistrar = createWebSearchRegistrar({
	runtime: { ...upstreamRuntime, reset: () => {} },
	notifyConfigIssues,
	cleanupOnShutdown: false,
});
export function registerWebSearchExtension(
	pi: ExtensionAPI,
	loadConfig: typeof loadToolkitConfig = loadToolkitConfig,
	requestSearch: typeof requestAlphaSearch = requestAlphaSearch,
	resolveRuntime: typeof upstreamRuntime.resolveResponsesEnvironment = upstreamRuntime.resolveResponsesEnvironment,
): void {
	upstreamRegistrar(pi, () => loadConfig(), requestSearch, resolveRuntime);
}
export function executeStandaloneWebRun(args: Omit<Parameters<typeof executeCore>[0], "loadConfig"> & {
	loadConfig?: typeof loadToolkitConfig;
}): ReturnType<typeof executeCore> {
	return executeCore({ ...args,
		loadConfig: () => (args.loadConfig ?? loadToolkitConfig)(),
		resolveRuntime: args.resolveRuntime ?? upstreamRuntime.resolveResponsesEnvironment,
		notifyConfigIssues: args.notifyConfigIssues ?? notifyConfigIssues,
	});
}
export default function webSearchExtension(pi: ExtensionAPI): void {
	registerWebSearchExtension(pi);
}
