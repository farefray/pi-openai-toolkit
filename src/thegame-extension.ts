import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProjectCompaction, createWebSearchRegistrar, type CompactionOverrides } from "./compaction-extension-core";
import { createToolkitRuntime } from "./runtime-core";
import { createRequestContextCache } from "./request-context-cache-core";
import { createConfigNotifier, createToolkitConfigCommandRegistrar, type ToolkitConfigReader } from "./config/notifications-core";
import { registerCodexAstraExtension } from "./codex-astra/extension";
import { loadThegamePolicy } from "./thegame-policy";

/** Factory-only load does declarations/registrations, without policy I/O or SDK mutation. */
export function registerThegameExtension(pi: ExtensionAPI, overrides: {
	loadConfig?: ToolkitConfigReader;
	compaction?: CompactionOverrides;
} = {}) {
	const runtime = createToolkitRuntime();
	const requestCache = createRequestContextCache();
	const notifier = createConfigNotifier();
	const loadConfig = overrides.loadConfig ?? loadThegamePolicy;
	let operationReader: ToolkitConfigReader = loadConfig;
	registerProjectCompaction(pi, loadConfig, {
		runtime, requestCache, notifyConfigIssues: notifier.notifyConfigIssues,
		registerConfigCommand: createToolkitConfigCommandRegistrar(),
		onOperationReader: (reader) => {
			operationReader = (ctx) => {
				let trusted = false;
				try { trusted = ctx.isProjectTrusted?.() === true; } catch { /* Unknown trust fails closed. */ }
				// Trust is checked before the reader can select a retained handoff snapshot.
				return trusted ? reader(ctx) : loadThegamePolicy({ cwd: "" });
			};
			return operationReader;
		},
	}, overrides.compaction);
	createWebSearchRegistrar({ runtime, notifyConfigIssues: notifier.notifyConfigIssues })(pi, (ctx) => operationReader(ctx));
	registerCodexAstraExtension(pi);
	pi.on("session_shutdown", () => notifier.reset());
	// Test/host inspection seam, not a process registry or a second lifecycle owner.
	return { runtime, requestCache };
}

export default function thegameExtension(pi: ExtensionAPI): void {
	registerThegameExtension(pi);
}
