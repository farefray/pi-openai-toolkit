import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "./config";
import { DEFAULT_TOOLKIT_CONFIG, type LoadedToolkitConfig } from "./types";

export const PROJECT_POLICY_PATH = ".pi/pi-openai-toolkit.json";
/** Read only after the host supplies a trusted project context. No cascade or global fallback. */
export function loadThegamePolicy(ctx: Pick<ExtensionContext, "cwd"> & { isProjectTrusted?: () => boolean }): LoadedToolkitConfig {
	let trusted = false;
	try { trusted = ctx.isProjectTrusted?.() === true; } catch { /* Unknown trust fails closed. */ }
	if (!trusted) {
		const config = structuredClone(DEFAULT_TOOLKIT_CONFIG);
		config.compaction.enabled = false;
		config.webSearch.enabled = false;
		config.imageGeneration.enabled = false;
		return { config, source: PROJECT_POLICY_PATH, warnings: [], document: {
			format: "invalid", configPath: PROJECT_POLICY_PATH, issues: [
				{ severity: "error", code: "project-not-trusted", path: "$", feature: "document" },
			],
		} };
	}
	if (!ctx.cwd || !path.isAbsolute(ctx.cwd)) throw new Error("Toolkit project policy requires a trusted absolute ctx.cwd.");
	const source = path.join(ctx.cwd, PROJECT_POLICY_PATH);
	const loaded = loadToolkitConfig(source);
	if (loaded.document?.format === "missing") {
		return {
			config: structuredClone(DEFAULT_TOOLKIT_CONFIG), source, warnings: [],
			document: Object.freeze({ format: "v2", configPath: source, issues: [], raw: Object.freeze({
				schemaVersion: 2,
				defaults: Object.freeze({ context: Object.freeze({ mode: "pi" }), webSearch: Object.freeze({ route: "unmanaged" }),
					imageGeneration: Object.freeze({ enabled: false }), responsesWebSocket: Object.freeze({ enabled: false }) }),
			}) }),
		};
	}
	// A project bridge never treats an unversioned document as upstream legacy policy.
	if (loaded.document?.format === "legacy") return {
		...loaded, source,
		document: { ...loaded.document, format: "invalid", issues: [
			{ severity: "error", code: "project-policy-requires-v2", path: "$", feature: "document" },
		] },
	};
	return { ...loaded, source };
}
