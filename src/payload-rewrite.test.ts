import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, resolveTranscriptTools, type Api, type Model } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import { removeNativeCompactionRetainedMessages, serializeLiveTailToResponsesInput, serializeLiveTailToResponsesInputWithLimits, serializeNativeCompactionTailWithLimits, rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite";
import { getGrammarToolInputProperties, serializeMessagesToResponsesInput } from "./serializer";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createCompactionExtension } from "./extension-runtime";
import { createRequestContextCache } from "./request-context-cache-core";
import { getRemoteV2InputProvenance, DEFAULT_TOOLKIT_CONFIG } from "./types";
import type { NativeCompactionRequestBody } from "./serializer";
import {
	createNativeCompactionDetails,
	NATIVE_COMPACTION_FALLBACK_SUMMARY,
	NATIVE_COMPACTION_INPUT_PROVENANCE,
} from "./types";

function fixture() {
	const manager = SessionManager.inMemory("C:/offline");
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	const firstKeptEntryId = manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_read|fc_read" }), { stopReason: "toolUse", timestamp: 2 }));
	manager.appendMessage({ role: "toolResult", toolCallId: "call_read|fc_read", toolName: "read", content: [{ type: "text", text: "real result" }], isError: false, timestamp: 3 });
	manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, firstKeptEntryId, 100,
		createNativeCompactionDetails({ provider: "openai", api: "openai-responses", model: "gpt-6-astra", baseUrl: "https://offline.invalid/v1", inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }] }));
	manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
	const branchEntries = manager.getBranch();
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
	assert(latest.ok);
	return { manager, branchEntries, compactionEntry: latest.entry, messages: manager.buildSessionContext().messages };
}

function removeRetained(
	args: Omit<Parameters<typeof removeNativeCompactionRetainedMessages>[0], "expectedInputProvenance">,
) {
	return removeNativeCompactionRetainedMessages({
		...args,
		expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
	});
}

const liveTailModel: Model<"openai-responses"> = {
	provider: "openai", api: "openai-responses", id: "gpt-6-astra", name: "GPT-6 Astra",
	baseUrl: "https://offline.invalid/v1", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};

describe("latest Pi retained context", () => {
	test("removes only verified retained copies, preserves transient/new messages and is immutable", () => {
		const args = fixture();
		const before = structuredClone(args.branchEntries);
		const transient = { role: "user" as const, content: "transient", timestamp: 5 };
		args.messages.splice(2, 0, transient);
		const messagesBefore = structuredClone(args.messages);
		const result = removeRetained(args);
		assert(result.ok);
		expect(result.messages).toEqual([args.messages[0], transient, args.messages.at(-1)]);
		expect(args.messages).toEqual(messagesBefore);
		expect(args.manager.getBranch()).toEqual(before);
		expect(removeRetained({ ...args, messages: result.messages })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("ignores a Pi 0.86 leading system prompt moved before the summary", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		manager.appendMessage({
			role: "system",
			content: "",
			sections: { preamble: "structured prompt" },
			toolsAdded: [],
			timestamp: 3,
		} as never);
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-system" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });

		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = manager.buildSessionContext().messages;
		const promotedSystem = messages.find((message) => (message.role as string) === "system");
		assert(promotedSystem);
		const promotedSystemShape = promotedSystem as unknown as { sections?: Record<string, string | null> };
		promotedSystemShape.sections = { preamble: "mutated after context rebuild" };
		const result = removeRetained({ messages, branchEntries, compactionEntry });

		assert(result.ok);
		expect(result.messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user"]);
		expect(result.messages[0]).toEqual(promotedSystem);
	});

	test("serializes a first live-tail system message as an update", () => {
		const manager = SessionManager.inMemory("C:/offline");
		manager.appendMessage({
			role: "system",
			content: "delta",
			sections: { rules: "updated", old: null },
			toolsAdded: [],
			timestamp: 1,
		} as never);

		expect(serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() })).toEqual([
			{
				role: "developer",
				content:
					'delta\n\nUpdated system prompt section "rules":\n\nupdated\n\nRemoved system prompt section "old".',
			},
		]);
	});

	test("rejects replay from a legacy opaque checkpoint without input provenance", () => {
		const args = fixture();
		assert(args.compactionEntry.details);
		delete (args.compactionEntry.details as unknown as Record<string, unknown>).inputProvenance;

		expect(removeRetained(args)).toEqual({
			ok: false,
			reason: "unverified-compaction-input",
		});
	});
	test("fails closed rather than removing half a modified tool batch", () => {
		const args = fixture();
		const messages = structuredClone(args.messages);
		const tool = messages.find((message) => message.role === "toolResult");
		assert(tool?.role === "toolResult");
		tool.content = [{ type: "text", text: "different" }];
		const before = structuredClone(messages);
		expect(removeRetained({ ...args, messages })).toEqual({ ok: false, reason: "retained-context-mismatch" });
		expect(messages).toEqual(before);
	});
	test("fails closed when every required retained message is modified", () => {
		const args = fixture();
		const messages = structuredClone(args.messages);
		for (const message of messages) {
			if (message.role === "assistant") {
				message.content = [{ type: "text", text: "modified assistant" }];
			}
			if (message.role === "toolResult") {
				message.content = [{ type: "text", text: "modified result" }];
			}
		}

		expect(removeRetained({ ...args, messages })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("fails closed when the complete required retained span is missing", () => {
		const args = fixture();
		const summaryIndex = args.messages.findIndex((message) => message.role === "compactionSummary");
		assert(summaryIndex >= 0);
		const messages = args.messages.filter((message, index) =>
			index <= summaryIndex || (message.role !== "assistant" && message.role !== "toolResult"),
		);

		expect(removeRetained({ ...args, messages })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("filtered custom content cannot hide a damaged required tool result", () => {
		const manager = SessionManager.inMemory("C:/offline");
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		const firstKeptEntryId = manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_read|fc_read" }), { stopReason: "toolUse", timestamp: 2 }),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read|fc_read",
			toolName: "read",
			content: [{ type: "text", text: "real result" }],
			isError: false,
			timestamp: 3,
		});
		manager.appendCustomMessageEntry("state", "filtered state", true, { internal: true });
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = structuredClone(manager.buildSessionContext().messages.filter(
			(message) => message.role !== "custom" || message.customType !== "state",
		));
		const tool = messages.find((message) => message.role === "toolResult");
		assert(tool?.role === "toolResult");
		tool.content = [{ type: "text", text: "tampered result" }];

		expect(removeRetained({ messages, branchEntries, compactionEntry })).toEqual({
			ok: false,
			reason: "retained-context-mismatch",
		});
	});
	test("removes exact retained custom copies when present", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendCustomMessageEntry("state", "exact custom", true, { version: 1 });
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-custom-exact" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });

		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = manager.buildSessionContext().messages;
		const result = removeRetained({ messages, branchEntries, compactionEntry });

		assert(result.ok);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]?.role).toBe("compactionSummary");
		expect(result.messages[1]).toEqual({ role: "user", content: "new", timestamp: 4 });
	});

	test("provider-visible custom metadata differences do not block retained filtering", () => {
		const manager = SessionManager.inMemory("C:/offline");
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		const firstKeptEntryId = manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_custom|fc_custom" }), { stopReason: "toolUse", timestamp: 2 }),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_custom|fc_custom",
			toolName: "read",
			content: [{ type: "text", text: "real result" }],
			isError: false,
			timestamp: 3,
		});
		manager.appendCustomMessageEntry("state", "original custom", true, { version: 1 });
		const compactionId = manager.appendCompaction(
			NATIVE_COMPACTION_FALLBACK_SUMMARY,
			firstKeptEntryId,
			100,
			createNativeCompactionDetails({
				provider: "openai",
				api: "openai-responses",
				model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1",
				inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				compactedWindow: [{ type: "compaction", encrypted_content: "opaque-custom" }],
			}),
		);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
		const branchEntries = manager.getBranch();
		const compactionEntry = branchEntries.find((entry) => entry.id === compactionId);
		assert(compactionEntry?.type === "compaction");
		const messages = structuredClone(manager.buildSessionContext().messages);
		const custom = messages.find((message) => message.role === "custom");
		assert(custom?.role === "custom");
		custom.content = "provider-visible custom clone";
		custom.details = { version: 2, changed: true };

		const result = removeRetained({ messages, branchEntries, compactionEntry });
		assert(result.ok);
		expect(result.messages).toContainEqual(custom);
		expect(result.messages.filter((message) => message.role === "assistant" || message.role === "toolResult")).toEqual([]);
	});
	test("filters recursive retained history without resurrecting an older summary", () => {
		const args = fixture();
		args.manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, args.compactionEntry.firstKeptEntryId, 200,
			createNativeCompactionDetails({ provider: "openai", api: "openai-responses", model: "gpt-6-astra",
				baseUrl: "https://offline.invalid/v1", inputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE, compactedWindow: [{ type: "compaction", encrypted_content: "opaque-recursive" }] }));
		args.manager.appendMessage({ role: "user", content: "After recursive compaction", timestamp: 6 });
		const branchEntries = args.manager.getBranch();
		const before = structuredClone(branchEntries);
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		const messages = args.manager.buildSessionContext().messages;
		expect(messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
		const result = removeRetained({ messages, branchEntries, compactionEntry: latest.entry });
		assert(result.ok);
		expect(result.messages).toEqual([messages[0], messages.at(-1)]);
		expect(args.manager.getBranch()).toEqual(before);
	});
	test("does not guess a missing boundary or summary", () => {
		const args = fixture();
		expect(removeRetained({ ...args, branchEntries: [] })).toEqual({ ok: false, reason: "compaction-boundary-not-found" });
		expect(removeRetained({ ...args, compactionEntry: { ...args.compactionEntry, firstKeptEntryId: "missing" } })).toEqual({ ok: false, reason: "first-kept-entry-not-found" });
		expect(removeRetained({ ...args, messages: args.messages.slice(1) })).toEqual({ ok: false, reason: "compaction-summary-not-found" });
	});
});


describe("recursive compaction dispatch envelope", () => {
	function harness(source: "legacy" | "pi-context-hook", messages: AgentMessage[], branchEntries: ReturnType<SessionManager["getBranch"]>,
		model: Model<Api>, project?: (messages: readonly AgentMessage[]) => readonly AgentMessage[]) {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		const requests: NativeCompactionRequestBody[] = [];
		let fallback = 0;
		const cache = createRequestContextCache();
		const ctx = { cwd: process.env.TEMP!, model, hasUI: true, ui: { notify() {} }, abort() {},
			getSystemPrompt: () => "current instructions", sessionManager: {
				getSessionId: () => "codec-worker", getBranch: () => branchEntries,
				buildSessionProjection: () => ({ messages: structuredClone(messages) }),
			}, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-not-a-credential" }) },
		};
		createCompactionExtension({ requestCache: cache,
			installContextHookPatch: () => ({ ok: false, reason: "disabled-by-policy" }) })(
			{ on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, getAllTools: () => [], getActiveTools: () => [] } as never,
			{ loadConfig: () => ({ config: { ...DEFAULT_TOOLKIT_CONFIG, compaction: { ...DEFAULT_TOOLKIT_CONFIG.compaction,
				remoteV2ContextSource: source, artifactRoot: process.env.TEMP! } }, warnings: [] }),
				projectCompactionContext: project ?? ((messages) => messages),
				remoteCompact: async (args) => { requests.push(structuredClone(args.request)); return {
					ok: true, status: 200, compactedWindow: [{ type: "compaction", encrypted_content: "next-opaque" }],
					createdAt: "2026-10-19T00:00:00Z", response: {},
				} as never; },
				standaloneCompact: async () => { throw new Error("unexpected standalone dispatch"); },
				nativeFallback: async () => { fallback++; throw new Error("unexpected summary fallback"); },
			});
		return { requests, cache, get fallback() { return fallback; }, run: () => handlers.get("session_before_compact")!({
			reason: "manual", branchEntries, signal: new AbortController().signal,
			preparation: { firstKeptEntryId: "keep", tokensBefore: 100, messagesToSummarize: [], turnPrefixMessages: [] },
		}, ctx) };
	}
	const model: Model<"openai-codex-responses"> = { ...liveTailModel, api: "openai-codex-responses",
		compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsOpenAIGrammarTools: true } };

	for (const source of ["legacy", "pi-context-hook"] as const) test(`${source}: full safe context before wire split, opaque window once, cached top-level tools authoritative`, async () => {
		const manager = SessionManager.inMemory("C:/offline");
		const tool = { name: "script", description: "offline", parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
			constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } };
		manager.appendMessage({ role: "system", content: "initial", toolsAdded: [tool], timestamp: 1 } as never);
		const kept = manager.appendMessage({ role: "user", content: "SEALED_RAW_HISTORY", timestamp: 2 });
		const opaque = [{ role: "user", content: "provider-kept", future: { exact: true } },
			{ type: "compaction", encrypted_content: "opaque" }, { role: "assistant", content: "provider-post" }];
		manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, kept, 100, createNativeCompactionDetails({
			provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
			inputProvenance: getRemoteV2InputProvenance(source), compactedWindow: opaque,
		}));
		manager.appendMessage({ role: "system", content: "", timestamp: 3 } as never);
		manager.appendMessage({ ...fauxAssistantMessage([{ type: "text", text: "unsigned" },
			fauxToolCall("script", { source: "return 1" }, { id: "call_script|ctc_script" })], { timestamp: 4, stopReason: "toolUse" }),
			provider: model.provider, api: model.api, model: model.id });
		manager.appendMessage({ role: "toolResult", toolCallId: "call_script|ctc_script", toolName: "script", content: [{ type: "text", text: "1" }], isError: false, timestamp: 5 });
		const branchEntries = manager.getBranch();
		const before = structuredClone(branchEntries);
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: model.baseUrl });
		assert(latest.ok);
		const messages = manager.buildSessionProjection().messages;
		const safe = removeNativeCompactionRetainedMessages({ messages, branchEntries, compactionEntry: latest.entry, expectedInputProvenance: getRemoteV2InputProvenance(source) });
		assert(safe.ok);
		const worker = harness(source, messages, branchEntries, model, () => safe.messages);
		const cachedTools = [{ type: "custom", name: "cache-authority", format: { type: "grammar", syntax: "regex", definition: ".*" } }];
		worker.cache.rememberRequestContext({ model: model.id, input: [], tools: cachedTools }, {
			provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, sessionId: "codec-worker",
		});
		expect(await worker.run()).toHaveProperty("compaction");
		expect(worker.requests).toHaveLength(1);
		const input = worker.requests[0].input;
		expect(input.slice(0, opaque.length)).toEqual(opaque);
		expect(input.slice(opaque.length)).toEqual(await serializeNativeCompactionTailWithLimits({ model, messages: safe.messages, summary: latest.entry.summary }));
		expect(input.filter((item) => item.type === "compaction")).toHaveLength(1);
		expect(input.find((item) => item.type === "message")).toMatchObject({ id: "msg_pi_2" });
		expect(input.find((item) => item.type === "custom_tool_call")).toMatchObject({ input: "return 1" });
		expect(JSON.stringify(input)).not.toContain("SEALED_RAW_HISTORY");
		expect(worker.requests[0].tools).toEqual(cachedTools);
		expect(worker.fallback).toBe(0);
		expect(manager.getBranch()).toEqual(before);
	});

	for (const nonAdditive of [false, true]) test(`cached ${nonAdditive ? "current" : "initial"} declarations stay authoritative alongside positioned input`, async () => {
		const initial = { name: "initial", description: "initial", parameters: { type: "object", properties: {} } };
		const later = { ...initial, name: "later", description: "later" };
		const messages: AgentMessage[] = [
			{ role: "system", content: "initial prompt", toolsAdded: [initial], timestamp: 1 } as AgentMessage,
			{ role: "user", content: "question", timestamp: 2 },
			{ role: "system", content: "later prompt", toolsAdded: [later], timestamp: 3 } as AgentMessage,
		];
		if (nonAdditive) messages.push({ role: "system", content: "final prompt", toolsRemoved: [{ name: "initial" }], timestamp: 4 } as AgentMessage);
		const topLevel = resolveTranscriptTools(messages, true);
		expect(topLevel.anchorsAdditions).toBe(!nonAdditive);
		expect(topLevel.requestTools).toEqual(nonAdditive ? [later] : [initial]);
		const tools = convertResponsesTools(topLevel.requestTools, { strict: null, supportsStrictMode: true, supportsOpenAIGrammarTools: true });
		const worker = harness("legacy", messages, [], model);
		worker.cache.rememberRequestContext({ model: model.id, input: [], tools }, {
			provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, sessionId: "codec-worker",
		});
		expect(await worker.run()).toHaveProperty("compaction");
		expect(worker.requests).toHaveLength(1);
		expect(worker.requests[0].tools).toEqual(tools);
		expect(worker.requests[0].input).toEqual(serializeMessagesToResponsesInput(model, messages));
		expect(worker.requests[0].input.filter((item) => item.type === "additional_tools")).toHaveLength(nonAdditive ? 0 : 1);
	});

	for (const kind of ["grammar-declaration", "grammar-input", "strict-schema"] as const) test(`${kind}: public hook cancels before dispatch and preserves history`, async () => {
		const tool = { name: "bad", description: "offline", parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
			constrainedSampling: { type: "grammar", variants: kind === "grammar-declaration" ? {} : { openai_lark: "start: /.+/" } } };
		if (kind === "strict-schema") {
			Object.assign(tool, { parameters: { type: "object", additionalProperties: true }, constrainedSampling: { type: "json_schema", strict: "require" } });
		}
		const messages: AgentMessage[] = [{ role: "system", content: "initial", toolsAdded: [tool], timestamp: 1 } as AgentMessage];
		if (kind === "grammar-input") messages.push({ ...fauxAssistantMessage(fauxToolCall("bad", { source: 123 }, { id: "call_bad|ctc_bad" }), { stopReason: "toolUse", timestamp: 2 }),
			provider: model.provider, api: model.api, model: model.id });
		const before = structuredClone(messages);
		const worker = harness("legacy", messages, [], model);
		expect(await worker.run()).toEqual({ cancel: true });
		expect(worker.requests).toHaveLength(0);
		expect(worker.fallback).toBe(0);
		expect(messages).toEqual(before);
	});
});

describe("full safe context recursive serialization", () => {
	const model: Model<"openai-codex-responses"> = { ...liveTailModel, api: "openai-codex-responses",
		compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsOpenAIGrammarTools: true } };
	const tool = { name: "script", description: "offline",
		parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
		constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } };
	function safeContext(): AgentMessage[] {
		return [
			{ role: "system", content: "initial", toolsAdded: [tool], timestamp: 1 } as AgentMessage,
			{ role: "compactionSummary", summary: "unique-checkpoint", tokensBefore: 10, timestamp: 2 },
			{ role: "system", content: "", timestamp: 3 } as AgentMessage,
			{ ...fauxAssistantMessage([{ type: "text", text: "unsigned one" }, { type: "text", text: "unsigned two" },
				fauxToolCall("script", { source: "return 1" }, { id: "call_script|ctc_script" })], { stopReason: "toolUse", timestamp: 4 }),
				provider: model.provider, api: model.api, model: model.id },
			{ role: "toolResult", toolCallId: "call_script|ctc_script", toolName: "script", content: [{ type: "text", text: "1" }], isError: false, timestamp: 5 },
		];
	}

	test("tail keeps full-context unsigned indexes and historical grammar; never estimates from opaque length", async () => {
		const messages = safeContext();
		const before = structuredClone(messages);
		const tail = await serializeNativeCompactionTailWithLimits({ model, messages, summary: "unique-checkpoint" });
		expect(tail).toEqual(serializeMessagesToResponsesInput(model, messages).slice(1));
		expect(tail).toEqual([
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "unsigned one", annotations: [] }], status: "completed", id: "msg_pi_2", phase: undefined },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "unsigned two", annotations: [] }], status: "completed", id: "msg_pi_2_1", phase: undefined },
			{ type: "custom_tool_call", id: "ctc_script", call_id: "call_script", name: "script", input: "return 1" },
			{ type: "custom_tool_call_output", call_id: "call_script", output: "1" },
		]);
		expect(messages).toEqual(before);
	});

	test("removal/redeclaration anywhere in full safe context disables tail additions", async () => {
		for (const change of [{ toolsRemoved: [{ name: "script" }] }, { toolsAdded: [tool] }]) {
			const messages = safeContext();
			messages.splice(1, 0, { role: "system", content: "sealed update", ...change, timestamp: 2 } as AgentMessage);
			messages.splice(3, 0, { role: "system", content: "tail update", toolsAdded: [{ name: "plain", description: "plain", parameters: { type: "object", properties: {} } }], timestamp: 3 } as AgentMessage);
			const tail = await serializeNativeCompactionTailWithLimits({ model, messages, summary: "unique-checkpoint" });
			expect(tail?.[0]).toEqual({ role: "developer", content: "tail update" });
			expect(tail?.some((item) => item.type === "additional_tools")).toBe(false);
			expect(tail?.find((item) => item.type === "custom_tool_call")).toMatchObject({ input: "return 1" });
		}
	});

	test("only selected tail images consume limits; past items are not replayed or resized", async () => {
		const messages = safeContext();
		const image = { type: "image" as const, data: "AQ==", mimeType: "image/png" };
		messages.splice(1, 0, { role: "user", content: [image, image], timestamp: 1 });
		messages.push({ role: "user", content: [image], timestamp: 6 });
		const limited = { ...model, input: ["text", "image"] as Array<"text" | "image">,
			inputLimits: { images: { maxPerMessage: 1, maxPerRequest: 1 } } };
		const tail = await serializeNativeCompactionTailWithLimits({ model: limited, messages, summary: "unique-checkpoint" });
		expect(tail?.at(-1)).toEqual({ role: "user", content: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AQ==" }] });
		expect(tail?.filter((item) => item.role === "user")).toHaveLength(1);
		messages.push({ role: "user", content: [image], timestamp: 7 });
		await expect(serializeNativeCompactionTailWithLimits({ model: limited, messages, summary: "unique-checkpoint" })).rejects.toThrow("per request");
	});

	test("missing, duplicate canonical or ambiguous wire summary anchors refuse", async () => {
		const messages = safeContext();
		await expect(serializeNativeCompactionTailWithLimits({ model, messages, summary: "missing" })).resolves.toBeUndefined();
		await expect(serializeNativeCompactionTailWithLimits({ model, messages: [...messages, messages[1]], summary: "unique-checkpoint" })).resolves.toBeUndefined();
		await expect(serializeNativeCompactionTailWithLimits({ model, messages: [...messages,
			{ role: "user", content: "<summary>unique-checkpoint</summary>", timestamp: 10 }], summary: "unique-checkpoint" })).resolves.toBeUndefined();
	});
});

describe("Pi 0.87 canonical context edits", () => {
	test("live tail applies omission and replacement without rewriting history", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const hidden = manager.appendMessage({ role: "user", content: "HIDDEN", timestamp: 1 });
		const changed = manager.appendMessage(fauxAssistantMessage("OLD", { timestamp: 2 }));
		manager.appendContextEdit(hidden, null);
		manager.appendContextEdit(changed, { content: "REPLACEMENT" });
		const before = structuredClone(manager.getBranch());
		const input = serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() });
		expect(JSON.stringify(input)).not.toContain("HIDDEN");
		expect(JSON.stringify(input)).not.toContain("OLD");
		expect(JSON.stringify(input)).toContain("REPLACEMENT");
		expect(manager.getBranch()).toEqual(before);
		manager.branch(changed);
		expect(JSON.stringify(serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() }))).toContain("HIDDEN");
	});
	test("retained entries use edits already included in the checkpoint", () => {
		const manager = SessionManager.inMemory("C:/offline");
		const hidden = manager.appendMessage({ role: "user", content: "HIDDEN", timestamp: 1 });
		const changed = manager.appendMessage(fauxAssistantMessage("OLD", { timestamp: 2 }));
		manager.appendContextEdit(hidden, null);
		manager.appendContextEdit(changed, { content: "REPLACEMENT" });
		const details = fixture().compactionEntry.details;
		manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, hidden, 100, details);
		manager.appendMessage({ role: "user", content: "new", timestamp: 4 });
		const branchEntries = manager.getBranch();
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		const messages = manager.buildSessionProjection().messages;
		const result = removeRetained({ branchEntries, compactionEntry: latest.entry, messages });
		assert(result.ok);
		expect(result.messages.map(m => m.role)).toEqual(["compactionSummary", "user"]);
		expect(JSON.stringify(result.messages)).not.toContain("REPLACEMENT");
	});
	for (const replacement of [null, { content: "redacted" }]) {
		test(`edit of checkpoint-covered input refuses opaque replay (${JSON.stringify(replacement)})`, () => {
			const args = fixture();
			args.manager.appendContextEdit(args.compactionEntry.firstKeptEntryId, replacement);
			const branchEntries = args.manager.getBranch();
			const messages = args.manager.buildSessionProjection().messages;
			expect(removeRetained({ ...args, branchEntries, messages })).toEqual({ ok: false, reason: "checkpoint-context-edited" });
			expect(rewriteResponsesPayloadWithNativeReplay({ model: liveTailModel, branchEntries, compactionEntry: args.compactionEntry,
				expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
				payload: { input: [{ role: "user", content: `<summary>${args.compactionEntry.summary}</summary>` }] },
			})).toEqual({ ok: false, reason: "checkpoint-context-edited" });
		});
	}
	test("retain-none compaction replays with no preceding retained entries", () => {
		const args = fixture();
		args.manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, null, 200, args.compactionEntry.details);
		args.manager.appendMessage({ role: "user", content: "after retain-none", timestamp: 8 });
		const branchEntries = args.manager.getBranch();
		const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: "https://offline.invalid/v1" });
		assert(latest.ok);
		expect(latest.entry.firstKeptEntryId).toBe(latest.entry.id);
		const messages = args.manager.buildSessionProjection().messages;
		expect(removeRetained({ branchEntries, compactionEntry: latest.entry, messages })).toEqual({ ok: true, messages });
		const result = rewriteResponsesPayloadWithNativeReplay({ model: liveTailModel, branchEntries, compactionEntry: latest.entry,
			expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE,
			payload: { input: [{ role: "user", content: `<summary>${latest.entry.summary}</summary>` }, { role: "user", content: "after retain-none" }] },
		});
		assert(result.ok);
		expect(result.rewrittenPayload.input).toEqual([{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "after retain-none" }]);
	});
});


test("canonical tail preserves tool pairs, normalizes latest replacement and omits custom context", () => {
	const manager = SessionManager.inMemory("C:/offline");
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "call_edit|fc_edit" }), { stopReason: "toolUse", timestamp: 1 }));
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "call_edit|fc_edit", toolName: "read", content: [{ type: "text", text: "old-result" }], isError: false, timestamp: 2 });
	const customId = manager.appendCustomMessageEntry("hidden", "hidden-custom", false);
	manager.appendContextEdit(resultId, { content: "intermediate-result" });
	manager.appendContextEdit(resultId, { content: "latest-result" });
	manager.appendContextEdit(customId, null);
	const before = structuredClone(manager.getBranch());
	const input = serializeLiveTailToResponsesInput({ model: liveTailModel, entries: manager.getBranch() });
	expect(input.filter(item => item.type === "function_call")).toHaveLength(1);
	expect(input.filter(item => item.type === "function_call_output")).toHaveLength(1);
	expect(JSON.stringify(input)).toContain("latest-result");
	for (const hidden of ["old-result", "intermediate-result", "hidden-custom"]) expect(JSON.stringify(input)).not.toContain(hidden);
	expect(manager.getBranch()).toEqual(before);
});

test("editing only post-checkpoint input keeps replay valid and navigation restores checkpoint reuse", () => {
	const args = fixture();
	const post = args.manager.getLeafId()!;
	args.manager.appendContextEdit(post, { content: "newly-edited-tail" });
	const safeLeaf = args.manager.getLeafId()!;
	const remove = () => removeRetained({ ...args, branchEntries: args.manager.getBranch(), messages: args.manager.buildSessionProjection().messages });
	let result = remove();
	assert(result.ok);
	expect(JSON.stringify(result.messages)).toContain("newly-edited-tail");
	args.manager.appendContextEdit(args.compactionEntry.firstKeptEntryId, null);
	expect(remove()).toEqual({ ok: false, reason: "checkpoint-context-edited" });
	args.manager.branch(safeLeaf);
	result = remove();
	assert(result.ok);
	expect(JSON.stringify(result.messages)).toContain("newly-edited-tail");
});

test("canonical checkpoint declarations feed sliced grammar tails; rewrite preserves SDK custom pair and tools once", async () => {
	const args = fixture();
	const tool = {
		name: "script", description: "offline",
		parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
		constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
	};
	args.manager.appendMessage({ role: "system", content: "", toolsAdded: [tool], timestamp: 5 } as never);
	args.manager.appendCompaction(NATIVE_COMPACTION_FALLBACK_SUMMARY, null, 200, args.compactionEntry.details);
	args.manager.appendMessage({
		...fauxAssistantMessage(fauxToolCall("script", { expression: "x + 1" }, { id: "call_script|ctc_script" }), { stopReason: "toolUse", timestamp: 6 }),
		provider: liveTailModel.provider, api: liveTailModel.api, model: liveTailModel.id,
	});
	args.manager.appendMessage({ role: "toolResult", toolCallId: "call_script|ctc_script", toolName: "script",
		content: [{ type: "text", text: "2" }], isError: false, timestamp: 7 });
	const branchEntries = args.manager.getBranch();
	const before = structuredClone(branchEntries);
	const latest = resolveLatestNativeCompactionEntry(branchEntries, { baseUrl: liveTailModel.baseUrl });
	assert(latest.ok);
	const model: Model<"openai-responses"> = { ...liveTailModel, compat: { supportsOpenAIGrammarTools: true } };
	// Only canonical projection metadata; never restore raw sealed messages.
	const fullProjection = args.manager.buildSessionProjection().messages;
	const properties = getGrammarToolInputProperties(model, fullProjection);
	expect(properties).toEqual(new Map([["script", "expression"]]));
	const boundary = branchEntries.findIndex(entry => entry.id === latest.entry.id);
	const tailEntries = branchEntries.slice(boundary + 1);
	const pair = [
		{ type: "custom_tool_call", id: "ctc_script", call_id: "call_script", name: "script", input: "x + 1" },
		{ type: "custom_tool_call_output", call_id: "call_script", output: "2" },
	];
	expect(serializeLiveTailToResponsesInput({ model, entries: tailEntries, grammarToolInputProperties: properties })).toEqual(pair);
	expect(await serializeLiveTailToResponsesInputWithLimits({ model, entries: tailEntries, grammarToolInputProperties: properties })).toEqual(pair);
	const tools = [{ type: "custom", name: "script", format: { type: "grammar", syntax: "regex", definition: ".*" } }];
	const payload = { input: [{ role: "user", content: `<summary>${latest.entry.summary}</summary>` }, ...pair], tools };
	const payloadBefore = structuredClone(payload);
	const rewritten = rewriteResponsesPayloadWithNativeReplay({ model, branchEntries, compactionEntry: latest.entry,
		expectedInputProvenance: NATIVE_COMPACTION_INPUT_PROVENANCE, payload });
	assert(rewritten.ok);
	expect(rewritten.rewrittenPayload.input).toEqual([{ type: "compaction", encrypted_content: "opaque" }, ...pair]);
	expect(rewritten.segments.post).toEqual(pair);
	expect(rewritten.rewrittenPayload.tools).toEqual(tools);
	expect(payload).toEqual(payloadBefore);
	expect(args.manager.getBranch()).toEqual(before);
});
