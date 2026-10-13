import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, loadToolkitConfig, resolveToolkitConfig, type ResolvedToolkitConfig } from "../config";
import type { LoadedToolkitConfig } from "../types";
import { previewToolkitMigration } from "./migration";
import { RETIRED_AUTO_MODE_ISSUE, RETIRED_AUTO_MODE_MESSAGE, type ConfigIssue } from "./policy";
import { redactValue } from "../debug";

export type ToolkitConfigReader = (ctx: ExtensionContext) => LoadedToolkitConfig;
export type ConfigNotifier = (ctx: ExtensionContext, resolved: ResolvedToolkitConfig) => void;
export function formatConfigIssues(issues: readonly ConfigIssue[], limit = 12): string {
	const lines = issues.slice(0, limit).map((issue) => `${issue.severity}: ${issue.path.slice(0, 220)} — ${issue.code === RETIRED_AUTO_MODE_ISSUE ? RETIRED_AUTO_MODE_MESSAGE : issue.code}`);
	if (issues.length > limit) lines.push(`${issues.length - limit} more issue(s); inspect the configuration file.`);
	return String(redactValue(lines.join("\n")));
}
export function createConfigNotifier() {
	let lastNotice = new WeakMap<object, string>();
	const notifyConfigIssues: ConfigNotifier = (ctx, resolved) => {
		const owner = ctx.sessionManager ?? ctx;
		if (resolved.issues.length === 0) { lastNotice.delete(owner); return; }
		if (!ctx.hasUI || typeof ctx.ui?.notify !== "function") return;
		const message = formatConfigIssues(resolved.issues, 4);
		const fingerprint = `${resolved.source ?? "defaults"}\n${resolved.modelKey ?? ""}\n${message}`;
		if (lastNotice.get(owner) === fingerprint) return;
		lastNotice.set(owner, fingerprint);
		ctx.ui.notify(`Toolkit configuration:\n${message}\nUse /toolkit-config validate for details.`,
			resolved.issues.some((issue) => issue.severity === "error") ? "error" : "warning");
	};
	return { notifyConfigIssues, reset: () => { lastNotice = new WeakMap(); } };
}
function boundedReport(text: string): string {
	const redacted = redactValue(text);
	const safe = typeof redacted === "string" ? redacted : "Configuration report unavailable.";
	return safe.length <= 24_000 ? safe : `${safe.slice(0, 24_000)}\n[Report truncated; do not use truncated JSON as a configuration file.]`;
}
function readLeaf(value: unknown, fieldPath: string): unknown {
	for (const key of fieldPath.split(".")) {
		if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
		value = Reflect.get(value, key);
	}
	return value;
}
export function describeToolkitConfig(resolved: ResolvedToolkitConfig): string {
	const lines = [
		`Toolkit configuration: ${resolved.source ?? CONFIG_PATH}`,
		`Format: ${resolved.format}; model: ${resolved.modelKey ?? "not selected"}`,
		`Invalid selected features: ${resolved.invalidFeatures.join(", ") || "none"}`,
		"Configuration intent only. Tool registration and backend capability are not verified.",
	];
	for (const [field, origin] of Object.entries(resolved.origins)) {
		const value = JSON.stringify(readLeaf(resolved.policy, field));
		lines.push(`${field} = ${value} [${origin.kind}${origin.path ? `: ${origin.path}` : ""}]`);
	}
	if (resolved.issues.length) lines.push("", formatConfigIssues(resolved.issues, 30));
	return boundedReport(lines.join("\n"));
}
/** Registration cache belongs to the caller's activation, not to an imported module. */
export function createToolkitConfigCommandRegistrar() {
	const registered = new WeakSet<object>();
	return (pi: ExtensionAPI, loadConfig: ToolkitConfigReader = () => loadToolkitConfig(), project = false): void => {
		if (registered.has(pi) || typeof pi.registerCommand !== "function") return;
		registered.add(pi);
		pi.registerCommand("toolkit-config", {
			description: `Read-only ${project ? "project" : "global"} configuration: /toolkit-config [show|validate|migration-preview]`,
			handler: async (args, ctx) => {
				if (!ctx.hasUI) throw new Error("/toolkit-config requires an interactive or RPC UI; it does not write reports to stdout.");
				const action = args.trim() || "show";
				if (!["show", "validate", "migration-preview"].includes(action)) {
					ctx.ui.notify("Usage: /toolkit-config [show|validate|migration-preview]", "warning"); return;
				}
				const loaded = loadConfig(ctx);
				const resolved = resolveToolkitConfig(loaded, ctx.model);
				if (action === "show") ctx.ui.notify(describeToolkitConfig(resolved), resolved.invalidFeatures.length ? "warning" : "info");
				else if (action === "validate") ctx.ui.notify(boundedReport(resolved.issues.length
					? `Toolkit configuration: ${loaded.document?.configPath ?? loaded.source ?? CONFIG_PATH}\n${formatConfigIssues(resolved.issues, 80)}`
					: "Toolkit configuration is valid. Backend support has not been tested."), resolved.issues.length ? "warning" : "info");
				else {
					const preview = previewToolkitMigration(loaded);
					ctx.ui.notify(boundedReport([
						`Migration preview: ${preview.status}. No file was changed.`, ...preview.reasons,
						...(preview.unmappedPaths.length ? [`Unmapped/dormant paths (unknown names masked): ${preview.unmappedPaths.join(", ")}`] : []),
						"Before any future manual apply, back up the original bytes and verify all installed Toolkit copies support v2.",
						...(preview.candidate ? ["Candidate (review required):", JSON.stringify(preview.candidate, null, 2)] : []),
					].join("\n")), preview.status === "needs-review" ? "warning" : "info");
				}
			},
		});
	};
}
