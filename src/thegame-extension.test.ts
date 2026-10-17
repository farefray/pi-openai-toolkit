import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { CodexContextWindowManager } from "./context-management/window-manager";
import { MANUAL_COMPACT_ENTRY_TYPE, decodeManualCompactRecord } from "./context-management/manual-compact";
import safeExtension, { registerThegameExtension } from "./thegame-extension";
import upstreamExtension from "./extension-runtime";
import { createToolkitRuntime } from "./runtime-core";
import { createRequestContextCache } from "./request-context-cache-core";
import { createConfigNotifier } from "./config/notifications-core";
import { resolveToolkitConfig } from "./config";
import { v2Fixture } from "./config/test-helpers";

const roots: string[] = [];
function project(contextMode = "pi", searchRoute = "unmanaged", inputSource = "legacy") {
	const cwd = mkdtempSync(join(tmpdir(), "toolkit-safe-")); roots.push(cwd); mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/pi-openai-toolkit.json"), JSON.stringify({ schemaVersion: 2, defaults: {
		context: { mode: contextMode, remoteCompaction: { inputSource } }, webSearch: { route: searchRoute },
	} }));
	return cwd;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const model = { provider: "p", id: "m", api: "openai-responses", baseUrl: "https://fixture.invalid/v1", compat: {} };
function harness(excluded: string[] = []) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const definitions: any[] = []; const commands = new Map<string, any>(); const notices: string[] = [];
	let loading = true; let active = ["read", "web_search"];
	const pi = new Proxy({
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(name: string, command: any) { if (commands.has(name)) throw new Error("duplicate command"); commands.set(name, command); },
		registerTool(tool: any) { if (definitions.some((existing) => existing.name === tool.name)) throw new Error("duplicate tool"); definitions.push(tool); if (!excluded.includes(tool.name)) active.push(tool.name); },
		getAllTools() { return definitions.filter((tool) => !excluded.includes(tool.name)); },
		getActiveTools() { return active; }, setActiveTools(names: string[]) { active = [...names]; },
	}, { get(target, key) {
		if (loading && !["on", "registerCommand", "registerTool"].includes(String(key))) throw new Error(`factory action: ${String(key)}`);
		return Reflect.get(target, key);
	} });
	function context(cwd: string, sessionId?: string): any {
		return { cwd, model, isProjectTrusted: () => true, hasUI: true, ui: { notify: (text: string) => notices.push(text) }, abort() {},
			modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic", baseUrl: model.baseUrl }) },
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getLeafId: () => null, buildSessionProjection: () => ({ messages: [] }) },
			getSystemPrompt: () => "Synthetic prompt", getContextUsage: () => undefined,
		};
	}
	async function emit(name: string, event: any, ctx: any) {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			const result = await handler(event, ctx); results.push(result);
			if (name === "before_provider_request" && result !== undefined) event = { ...event, payload: result };
		}
		return results;
	}
	return { pi, commands, definitions, notices, context, emit, loaded: () => { loading = false; }, active: () => active };
}
async function managedComposition() {
	const host = harness();
	const cwd = project();
	const sm = SessionManager.inMemory(cwd);
	const models = ["original", "checkpoint"].map((id) => ({
		...model, provider: "managed", id, name: id, reasoning: id === "original", input: ["text"],
		contextWindow: 64000, maxTokens: 2048,
	}));
	let selected = models[0];
	let thinking = "high";
	const ctx = host.context(cwd, sm.getSessionId());
	Object.defineProperty(ctx, "model", { get: () => selected });
	ctx.sessionManager = sm;
	ctx.isIdle = () => true;
	ctx.modelRegistry = {
		find: (provider: string, id: string) => provider === "managed" ? models.find((candidate) => candidate.id === id) : undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic", headers: {} }),
	};
	const policy = (route: string) => JSON.stringify({ schemaVersion: 2, defaults: {
		context: { mode: "remote-windows", remoteCompaction: { model: "managed/checkpoint" } },
		webSearch: { route },
	}, models: Object.fromEntries(models.map((candidate) => [`managed/${candidate.id}`, { compatibility: { transport: "codex-gateway" } }])) });
	const file = join(cwd, ".pi/pi-openai-toolkit.json");
	writeFileSync(file, policy("hosted"));
	Object.assign(host.pi, {
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, structuredClone(data)),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; void host.emit("thinking_level_select", { level }, ctx); },
		setModel: async (next: typeof selected) => {
			const previousModel = selected;
			selected = next;
			if (!next.reasoning) thinking = "off";
			sm.appendModelChange(next.provider, next.id);
			await host.emit("model_select", { model: next, previousModel, source: "set" }, ctx);
			return true;
		},
		sendUserMessage: (content: string) => {
			void host.emit("message_start", { message: { role: "user", content } }, ctx);
			sm.appendMessage({ role: "user", content, timestamp: Date.now() });
		},
		sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) =>
			sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details),
	});
	registerThegameExtension(host.pi as never, { compaction: { contextWindows: new CodexContextWindowManager(async () => undefined) } });
	host.loaded();
	sm.appendMessage({ role: "user", content: "Synthetic task", timestamp: 1 });
	await host.emit("session_start", {}, ctx);
	sm.appendMessage(fauxAssistantMessage("Working"));
	const records = () => sm.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === MANUAL_COMPACT_ENTRY_TYPE
		? [decodeManualCompactRecord(entry.data)!] : []);
	const begin = async () => {
		const result = await host.emit("session_before_compact", {
			reason: "manual", signal: new AbortController().signal,
			preparation: { firstKeptEntryId: sm.getLeafId(), tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
		}, ctx);
		expect(result).toContainEqual({ cancel: true });
		expect(records().at(-1)?.phase).toBe("requested");
		await host.emit("session_compact_failed", { reason: "manual" }, ctx);
		expect(ctx.model.id).toBe("checkpoint");
		expect(records().at(-1)?.phase).toBe("checkpointing");
	};
	const complete = async () => {
		sm.appendMessage(fauxAssistantMessage(fauxToolCall("notes", {
			action: "write_file", path: "/root/notes/synthetic.md", text: "checkpoint",
		}, { id: "fresh-note" })));
		sm.appendMessage({ role: "toolResult", toolName: "notes", toolCallId: "fresh-note", isError: false,
			content: [{ type: "text", text: "success" }], details: { codexHistoryNotes: { success: true } }, timestamp: 2 });
		const tool = host.definitions.find((definition) => definition.name === "new_context");
		expect(await tool.execute("roll", {}, undefined, undefined, ctx)).toMatchObject({ details: { started: true }, terminate: true });
		await host.emit("turn_end", {}, ctx);
		await host.emit("agent_settled", {}, ctx);
		expect(ctx.model.id).toBe("original");
		expect(thinking).toBe("high");
		expect(records().at(-1)?.phase).toBe("completed");
	};
	const payload = () => ({ model: ctx.model.id, input: [], tools: [{ type: "function", name: "web_search" }] });
	return { host, ctx, file, policy, begin, complete, payload };
}

for (const change of ["valid local", "malformed"] as const) {
	test(`managed composition shares its search snapshot across ${change} policy edits until restoration`, async () => {
		const h = await managedComposition();
		try {
			await h.begin();
			writeFileSync(h.file, change === "malformed" ? "{" : h.policy("local"));
			const prompt = await h.host.emit("before_agent_start", { systemPrompt: "Base" }, h.ctx);
			expect(prompt.find((result) => result?.systemPrompt)?.systemPrompt).toContain("## Web Search");
			const results = await h.host.emit("before_provider_request", { payload: h.payload() }, h.ctx);
			expect(results.findLast((result) => result?.tools)?.tools).toContainEqual({ type: "web_search" });
			expect(h.host.active()).not.toContain("web_search");
			await h.complete();
			if (change === "malformed") {
				await expect(h.host.emit("before_provider_request", { payload: h.payload() }, h.ctx)).rejects.toThrow("configuration is invalid");
			} else {
				const next = await h.host.emit("before_provider_request", { payload: h.payload() }, h.ctx);
				expect(next.findLast((result) => result?.tools)?.tools).toEqual([{ type: "function", name: "web_search" }]);
				expect(h.host.active()).toContain("web_search");
			}
		} finally { await h.host.emit("session_shutdown", {}, h.ctx); }
	});
}

test("revoked, missing and throwing trust cannot expose an enabled managed search snapshot", async () => {
	const h = await managedComposition();
	try {
		await h.begin();
		writeFileSync(h.file, "{");
		for (const trust of [() => false, undefined, () => { throw new Error("unknown trust"); }]) {
			h.ctx.isProjectTrusted = trust;
			await expect(h.host.emit("before_provider_request", { payload: h.payload() }, h.ctx)).rejects.toThrow("configuration is invalid");
			const webRun = h.host.definitions.find((tool) => tool.name === "web_run");
			await expect(webRun.execute("id", { search_query: [{ q: "synthetic" }] }, undefined, undefined, h.ctx)).rejects.toThrow("configuration is invalid");
			const blocked = await h.host.emit("before_agent_start", { systemPrompt: "Base" }, h.ctx);
			expect(blocked.every((result) => result?.systemPrompt === undefined)).toBe(true);
			h.ctx.isProjectTrusted = () => true;
			const restored = await h.host.emit("before_agent_start", { systemPrompt: "Base" }, h.ctx);
			expect(restored.find((result) => result?.systemPrompt)?.systemPrompt).toContain("## Web Search");
		}
		await h.complete();
		await expect(h.host.emit("before_provider_request", { payload: h.payload() }, h.ctx)).rejects.toThrow("configuration is invalid");
	} finally { h.ctx.isProjectTrusted = () => true; await h.host.emit("session_shutdown", {}, h.ctx); }
});

test("factory-only safe load registers once, reads no policy, and leaves SDK prototypes/registry untouched", () => {
	const host = harness(); let reads = 0;
	const prototype = ExtensionRunner.prototype.createContext; const providers = getApiProviders();
	const originalFetch = globalThis.fetch; const originalTimeout = globalThis.setTimeout; const originalInterval = globalThis.setInterval;
	globalThis.fetch = (() => { throw new Error("factory network"); }) as any;
	globalThis.setTimeout = (() => { throw new Error("factory timer"); }) as any;
	globalThis.setInterval = (() => { throw new Error("factory timer"); }) as any;
	try {
		registerThegameExtension(host.pi as never, { loadConfig: () => { reads++; throw new Error("factory disk policy"); } });
		expect(reads).toBe(0);
		expect(ExtensionRunner.prototype.createContext).toBe(prototype);
		expect(getApiProviders()).toEqual(providers);
		expect(host.commands.size).toBe(1);
		expect(host.commands.has("fast")).toBe(false);
		expect(host.definitions.map((tool) => tool.name)).not.toContain("openai_generate_image");
	} finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval; }
});
test("upstream installer remains default, while safe composition never calls it", () => {
	const host = harness(); let installed = 0;
	upstreamExtension(host.pi as never, { activation: { installContextHookPatch: () => { installed++; return { ok: true, installed: true }; } } });
	expect(installed).toBe(1);
	const safe = harness(); registerThegameExtension(safe.pi as never, { compaction: {
		activation: { installContextHookPatch: () => { throw new Error("must not install"); } },
	} });
	expect(installed).toBe(1);
});
test("two project activations capture disjoint extras even without session IDs and shut down independently", async () => {
	const a = harness(), b = harness(); const calls: any[] = [];
	const overrides = { compaction: { remoteCompact: async (args: any) => { calls.push(args); return { ok: false, reason: "aborted" as const }; } } };
	const ownerA = registerThegameExtension(a.pi as never, overrides), ownerB = registerThegameExtension(b.pi as never, overrides);
	a.loaded(); b.loaded();
	const ctxA = a.context(project("remote-compaction", "hosted")), ctxB = b.context(project("remote-compaction", "unmanaged"));
	await Promise.all([a.emit("session_start", {}, ctxA), b.emit("session_start", {}, ctxB)]);
	const payload = (name: string) => ({ model: "m", input: [], tools: [{ type: "function", name }], reasoning: { effort: name } });
	const resultA = await a.emit("before_provider_request", { payload: payload("read-a") }, ctxA);
	const resultB = await b.emit("before_provider_request", { payload: payload("read-b") }, ctxB);
	expect(resultA.find((result) => result?.tools)?.tools).toContainEqual({ type: "web_search" });
	expect(resultB.every((result) => result === undefined)).toBe(true);
	const event = { reason: "manual", signal: new AbortController().signal, branchEntries: [], preparation: {
		firstKeptEntryId: "synthetic", tokensBefore: 1, messagesToSummarize: [], turnPrefixMessages: [],
	} };
	await a.emit("session_before_compact", event, ctxA); await b.emit("session_before_compact", event, ctxB);
	expect(calls.map((call) => call.request.reasoning.effort)).toEqual(["read-a", "read-b"]);
	expect(calls[0].request.tools).toEqual([{ type: "function", name: "read-a" }]);
	expect(calls[1].request.tools).toEqual([{ type: "function", name: "read-b" }]);
	const identity = { provider: "p", api: model.api, model: "m", baseUrl: model.baseUrl };
	await a.emit("session_shutdown", {}, ctxA);
	expect(ownerA.requestCache.getCompactionRequestExtras(identity)).toBeUndefined();
	expect(ownerB.requestCache.getCompactionRequestExtras(identity)?.reasoning).toEqual({ effort: "read-b" });
	await b.commands.get("toolkit-config").handler("show", ctxB);
	expect(b.notices.at(-1)).toContain(join(ctxB.cwd, ".pi/pi-openai-toolkit.json"));
	expect(b.commands.get("toolkit-config").description).toContain("project");
});
test("missing projector cancels before remote or native fallback, without changing preparation", async () => {
	const host = harness(); let calls = 0;
	registerThegameExtension(host.pi as never, { compaction: {
		remoteCompact: async () => { calls++; throw new Error("raw remote input"); },
		nativeFallback: async () => { calls++; throw new Error("native fallback"); },
	} }); host.loaded();
	const ctx = host.context(project("remote-compaction", "unmanaged", "pi-context-hook"));
	const event = { reason: "manual", signal: new AbortController().signal, preparation: {
		firstKeptEntryId: "keep", tokensBefore: 1, messagesToSummarize: [], turnPrefixMessages: [],
	} };
	const before = JSON.stringify(event.preparation);
	expect(await host.emit("session_before_compact", event, ctx)).toContainEqual({ cancel: true });
	expect(calls).toBe(0); expect(JSON.stringify(event.preparation)).toBe(before);
});
test("host-excluded child tools remain excluded, including execute and later lifecycle retries", async () => {
	const host = harness(["new_context", "get_context_remaining", "history", "notes", "web_run"]);
	safeExtension(host.pi as never); host.loaded();
	const ctx = host.context(project("pi", "standalone-alpha"));
	await host.emit("session_start", {}, ctx); await host.emit("before_agent_start", { systemPrompt: "Prompt" }, ctx);
	expect(host.active()).not.toContain("web_run");
	const tool = host.definitions.find((tool) => tool.name === "web_run");
	await expect(tool.execute("id", { search_query: [{ q: "synthetic" }] }, undefined, undefined, ctx)).rejects.toThrow("not registered");
	await host.emit("model_select", { model }, ctx); expect(host.active()).not.toContain("web_run");
});
test("activation-owned physical fallback and issue notice caches do not share registry/session keys", async () => {
	const a = createToolkitRuntime(), b = createToolkitRuntime();
	const virtual = { ...model, provider: "router", id: "auto", api: "pi-virtual" };
	const ctx = { model: virtual, sessionManager: { getSessionId: () => "same" }, modelRegistry: { find: () => model } } as never;
	a.rememberPhysicalModel(ctx, { role: "assistant", provider: model.provider, api: model.api, model: model.id } as never);
	expect((await a.resolveEffectiveModel(ctx)).ok).toBe(true); expect((await b.resolveEffectiveModel(ctx)).ok).toBe(false);
	a.reset(); expect((await a.resolveEffectiveModel(ctx)).ok).toBe(false);
	const messages: string[] = []; const noticeCtx = { sessionManager: {}, hasUI: true, ui: { notify: (message: string) => messages.push(message) } } as never;
	const one = createConfigNotifier(), two = createConfigNotifier();
	const invalid = resolveToolkitConfig(v2Fixture({ defaults: { webSearch: { route: "bad" } } }), model);
	one.notifyConfigIssues(noticeCtx, invalid); one.notifyConfigIssues(noticeCtx, invalid); two.notifyConfigIssues(noticeCtx, invalid);
	expect(messages).toHaveLength(2);
	const requestA = createRequestContextCache(), requestB = createRequestContextCache();
	const identity = { provider: "p", api: model.api, model: "m", baseUrl: model.baseUrl };
	requestA.rememberRequestContext({ model: "m", input: [], parallel_tool_calls: false }, identity);
	expect(requestB.getCompactionRequestExtras(identity)).toBeUndefined();
});
test("untrusted globally loaded safe extension cannot enable a malicious project policy", async () => {
	const host = harness(); let calls = 0;
	registerThegameExtension(host.pi as never, { compaction: { remoteCompact: async () => { calls++; throw new Error("must not dispatch"); } } });
	host.loaded();
	const ctx = host.context(project("remote-compaction", "hosted")); ctx.isProjectTrusted = () => false;
	await host.emit("session_start", {}, ctx);
	expect(host.active()).not.toContain("web_run");
	await expect(host.emit("before_provider_request", { payload: { model: "m", input: [] } }, ctx)).rejects.toThrow("configuration is invalid");
	expect(await host.emit("session_before_compact", { preparation: {} }, ctx)).toContainEqual({ cancel: true });
	expect(calls).toBe(0);
});
test("upstream search facade keeps repeated registration idempotent", async () => {
	const { registerWebSearchExtension } = await import("./web-search/extension");
	const host = harness();
	registerWebSearchExtension(host.pi as never);
	registerWebSearchExtension(host.pi as never);
	expect(host.definitions.filter((tool) => tool.name === "web_run")).toHaveLength(1);
});
test("missing policy keeps third-party search while malformed reload blocks dependent operations", async () => {
	const host = harness(); let dispatched = 0;
	registerThegameExtension(host.pi as never, { compaction: { remoteCompact: async () => { dispatched++; throw new Error("must not dispatch"); } } });
	host.loaded();
	const cwd = mkdtempSync(join(tmpdir(), "toolkit-missing-")); roots.push(cwd); mkdirSync(join(cwd, ".pi"));
	const ctx = host.context(cwd);
	await host.emit("session_start", {}, ctx);
	expect(host.active()).toEqual(["read", "web_search"]);
	const payload = { model: "m", input: [], tools: [{ type: "function", name: "web_search" }] };
	expect((await host.emit("before_provider_request", { payload }, ctx)).every((result) => result === undefined)).toBe(true);
	writeFileSync(join(cwd, ".pi/pi-openai-toolkit.json"), "{");
	await expect(host.emit("before_provider_request", { payload }, ctx)).rejects.toThrow("configuration is invalid");
	const event = { signal: new AbortController().signal, preparation: {} };
	expect(await host.emit("session_before_compact", event, ctx)).toContainEqual({ cancel: true });
	const tool = host.definitions.find((tool) => tool.name === "web_run");
	await expect(tool.execute("id", { search_query: [{ q: "synthetic" }] }, undefined, undefined, ctx)).rejects.toThrow("configuration is invalid");
	expect(dispatched).toBe(0);
});
for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna", "unconfigured-model"]) {
	test(`model-specific hosted trial preserves Exa/native context and rolls back: ${id}`, async () => {
		const host = harness(); let remoteCalls = 0;
		registerThegameExtension(host.pi as never, { compaction: {
			remoteCompact: async () => { remoteCalls++; throw new Error("unexpected remote compaction"); },
		} }); host.loaded();
		host.pi.setActiveTools(["read", "exa_search", "web_search"]);
		const cwd = project();
		const file = join(cwd, ".pi/pi-openai-toolkit.json");
		const policy = { schemaVersion: 2, defaults: {
			context: { mode: "pi" }, webSearch: { route: "unmanaged" },
			imageGeneration: { enabled: false }, responsesWebSocket: { enabled: false },
		}, models: Object.fromEntries(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"].map((key) => [
			`openai-codex/${key}`, { webSearch: { route: "hosted" } },
		])) };
		writeFileSync(file, JSON.stringify(policy));
		const ctx = host.context(cwd);
		ctx.model = { ...model, provider: "openai-codex", id, api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api/codex" };
		await host.emit("session_start", {}, ctx);
		const prompt = await host.emit("before_agent_start", { systemPrompt: "Base" }, ctx);
		const payload = { model: id, input: [{ role: "user", content: "Synthetic" }],
			tools: [{ type: "function", name: "exa_search" }, { type: "function", name: "web_search" }],
			reasoning: { effort: "high" } };
		const before = structuredClone(payload);
		const results = await host.emit("before_provider_request", { payload }, ctx);
		const wire = results.findLast((result) => result !== undefined) ?? payload;
		const enabled = id !== "unconfigured-model";
		expect(prompt.some((result) => result?.systemPrompt?.includes("## Web Search"))).toBe(enabled);
		expect(wire.tools).toContainEqual({ type: "function", name: "exa_search" });
		expect(wire.tools.some((tool: any) => tool.type === "web_search")).toBe(enabled);
		expect(wire.tools.some((tool: any) => tool.name === "web_search")).toBe(!enabled);
		if (enabled) expect(wire.include).toContain("web_search_call.action.sources");
		expect(wire.input).toEqual(before.input);
		expect(payload).toEqual(before);
		expect(host.active()).toContain("exa_search");
		for (const tool of ["history", "notes", "new_context", "get_context_remaining", "web_run"])
			expect(host.active()).not.toContain(tool);
		const compaction = await host.emit("session_before_compact", {
			signal: new AbortController().signal, branchEntries: ctx.sessionManager.getBranch(), preparation: {},
		}, ctx);
		expect(compaction.every((result) => result === undefined)).toBe(true);
		expect(remoteCalls).toBe(0);
		writeFileSync(file, JSON.stringify({ ...policy, models: {} }));
		await host.emit("model_select", { model: ctx.model }, ctx);
		expect(host.active()).toContain("web_search");
		expect((await host.emit("before_provider_request", { payload }, ctx)).every((result) => result === undefined)).toBe(true);
		await host.emit("session_shutdown", {}, ctx);
	});
}

test("selected subpackage exposes only safe resource and root manifest keeps upstream resources", () => {
	const selected = JSON.parse(readFileSync(new URL("../thegame/package.json", import.meta.url), "utf8"));
	const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	expect(selected.pi.extensions).toEqual(["../src/thegame-extension.ts"]);
	expect(root.pi.extensions).not.toContain("./src/thegame-extension.ts");
	expect(root.pi.extensions).toEqual([
		"./src/extension-runtime.ts", "./src/web-search/extension.ts", "./src/image-generation/extension.ts",
		"./src/codex-fast/extension.ts", "./src/codex-astra/extension.ts", "./src/responses-websocket/extension.ts",
	]);
});
