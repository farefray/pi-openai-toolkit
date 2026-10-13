import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadThegamePolicy } from "./thegame-policy";
import { resolveToolkitConfig } from "./config";
const roots: string[] = [];
function project(text?: string) {
	const cwd = mkdtempSync(join(tmpdir(), "toolkit-policy-")); roots.push(cwd);
	mkdirSync(join(cwd, ".pi"));
	if (text !== undefined) writeFileSync(join(cwd, ".pi/pi-openai-toolkit.json"), text);
	return { cwd, isProjectTrusted: () => true };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { provider: "p", id: "m", api: "openai-responses" };
test("missing project policy is explicit inactive v2, not upstream remote defaults", () => {
	const ctx = project(); const loaded = loadThegamePolicy(ctx); const resolved = resolveToolkitConfig(loaded, model);
	expect(resolved.format).toBe("v2");
	expect(resolved.source).toBe(join(ctx.cwd, ".pi/pi-openai-toolkit.json"));
	expect(resolved.policy.context.mode).toBe("pi");
	expect(resolved.policy.webSearch.route).toBe("unmanaged");
	expect(resolved.policy.imageGeneration.enabled).toBe(false);
	expect(resolved.policy.responsesWebSocket.enabled).toBe(false);
	expect(resolved.invalidFeatures).toEqual([]);
});
for (const [name, text] of [["malformed", "{"], ["legacy", "{}"], ["unsupported", '{"schemaVersion":3}']] as const) {
	test(`${name} policy blocks dependent features and keeps project source`, () => {
		const ctx = project(text); const resolved = resolveToolkitConfig(loadThegamePolicy(ctx), model);
		expect(resolved.invalidFeatures).toContain("context");
		expect(resolved.invalidFeatures).toContain("webSearch");
		expect(resolved.source).toBe(join(ctx.cwd, ".pi/pi-openai-toolkit.json"));
	});
}
test("unreadable policy fails closed rather than using global policy", () => {
	const ctx = project(); mkdirSync(join(ctx.cwd, ".pi/pi-openai-toolkit.json"));
	const resolved = resolveToolkitConfig(loadThegamePolicy(ctx), model);
	expect(resolved.issues.some((issue) => issue.code === "unreadable-config")).toBe(true);
	expect(resolved.invalidFeatures).toContain("context");
});
test("exact project schema resolution and snapshots are independent across cwd and edits", () => {
	const a = project('{"schemaVersion":2,"defaults":{"context":{"mode":"pi"},"webSearch":{"route":"hosted"}}}');
	const b = project('{"schemaVersion":2,"defaults":{"context":{"mode":"pi"},"webSearch":{"route":"local"}}}');
	const snapshot = loadThegamePolicy(a);
	writeFileSync(join(a.cwd, ".pi/pi-openai-toolkit.json"), "{");
	expect(resolveToolkitConfig(snapshot, model).policy.webSearch.route).toBe("hosted");
	expect(resolveToolkitConfig(loadThegamePolicy(b), model).policy.webSearch.route).toBe("local");
	expect(resolveToolkitConfig(loadThegamePolicy(a), model).invalidFeatures).toContain("webSearch");
});
test("untrusted, unknown and throwing trust never read project policy or access cwd", () => {
	const malicious = project('{"schemaVersion":2,"defaults":{"context":{"mode":"remote-windows"},"webSearch":{"route":"hosted"},"imageGeneration":{"enabled":true}}}');
	const denied = resolveToolkitConfig(loadThegamePolicy({ ...malicious, isProjectTrusted: () => false }), model);
	expect(denied.invalidFeatures).toContain("context"); expect(denied.invalidFeatures).toContain("webSearch");
	expect(denied.config.compaction.enabled).toBe(false); expect(denied.config.webSearch.enabled).toBe(false);
	for (const trust of [() => false, undefined, () => { throw new Error("unknown trust"); }]) {
		const ctx = { get cwd(): string { throw new Error("untrusted cwd accessed"); }, isProjectTrusted: trust };
		const resolved = resolveToolkitConfig(loadThegamePolicy(ctx), model);
		expect(resolved.issues.some((issue) => issue.code === "project-not-trusted")).toBe(true);
	}
});
test("policy discovery refuses missing or relative cwd", () => {
	expect(() => loadThegamePolicy({ cwd: "", isProjectTrusted: () => true })).toThrow("trusted absolute");
	expect(() => loadThegamePolicy({ cwd: "relative", isProjectTrusted: () => true })).toThrow("trusted absolute");
});
