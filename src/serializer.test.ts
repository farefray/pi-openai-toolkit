import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, getDeclaredTools, normalizeContext, resolveTranscriptTools, type Api, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
// SDK API subpaths are test-only parity oracles. Production uses root helpers.
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	GrammarToolSerializationError,
	ToolDeclarationSerializationError,
	getGrammarToolInputProperties,
	createResponsesInputParitySignature,
	serializeLlmMessagesToResponsesInput,
	serializeMessagesToResponsesInput,
	serializeMessagesToResponsesInputWithLimits,
} from "./serializer";
const model: Model<"openai-responses"> = {
	provider: "openai", api: "openai-responses", id: "gpt-6-astra", name: "GPT-6 Astra",
	baseUrl: "https://offline.invalid/v1", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};
const calls = [
	{ type: "toolCall" as const, id: "call_a|fc_a", name: "read", arguments: { path: "a" } },
	{ type: "toolCall" as const, id: "call_b|fc_b", name: "read", arguments: { path: "b" } },
];
function assistant(stopReason: "toolUse" | "error" | "aborted" = "toolUse"): Message {
	return {
		role: "assistant", provider: model.provider, api: model.api, model: model.id,
		content: structuredClone(calls), stopReason, timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function result(index: number): Message {
	return { role: "toolResult", toolCallId: calls[index].id, toolName: "read", isError: false,
		content: [{ type: "text", text: `real-${index}` }], timestamp: 2 + index };
}

function systemMessage(
	content: string | Array<{ type: "text"; text: string }>,
	sections?: Record<string, string | null>,
): Message {
	return { role: "system", content, sections, timestamp: 3 } as unknown as Message;
}

const nonReasoningModel: Model<"openai-responses"> = { ...model, reasoning: false };
const noDeveloperRoleModel: Model<"openai-responses"> = {
	...model,
	compat: { supportsDeveloperRole: false },
};

describe("Responses trailing tool pairing", () => {
	for (const completed of [0, 1, 2]) {
		test(`completes a trailing batch with ${completed} real results without mutating history`, () => {
			const messages = [assistant(), ...Array.from({ length: completed }, (_, index) => result(index))];
			const before = structuredClone(messages);
			const input = serializeMessagesToResponsesInput(model, messages);
			const outputs = input.filter((item) => item.type === "function_call_output");
			expect(outputs).toHaveLength(2);
			for (let index = 0; index < calls.length; index++) {
				expect(outputs[index]).toMatchObject({ type: "function_call_output", call_id: `call_${index === 0 ? "a" : "b"}` });
				expect(JSON.stringify(outputs[index].output)).toContain(index < completed ? `real-${index}` : "No result provided");
			}
			expect(input.filter((item) => item.type === "function_call").map((item) => item.call_id)).toEqual(["call_a", "call_b"]);
			expect(messages).toEqual(before);
		});
	}
	test("leaves empty/text-only histories alone and skips failed assistant calls", () => {
		expect(serializeMessagesToResponsesInput(model, [])).toEqual([]);
		for (const messages of [
			[{ role: "user", content: "hello", timestamp: 1 } as Message],
			[assistant("error")], [assistant("aborted")],
		]) {
			expect(serializeMessagesToResponsesInput(model, messages).some((item) => item.type === "function_call_output")).toBe(false);
		}
	});
});

describe("Responses image input limits", () => {
	const limitedModel: Model<"openai-responses"> = {
		...model,
		input: ["text", "image"],
		inputLimits: { images: { maxPerMessage: 1, maxPerRequest: 2 } },
	};
	const image = { type: "image" as const, data: "AQ==", mimeType: "image/png" };

	test("enforces per-message and per-request counts without mutating messages", async () => {
		const one = { role: "user" as const, content: [image], timestamp: 1 };
		const before = structuredClone(one);
		const serialized = await serializeMessagesToResponsesInputWithLimits(limitedModel, [one]);
		expect(serialized).toEqual([{
			role: "user",
			content: [{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AQ==" }],
		}]);
		expect(one).toEqual(before);

		await expect(
			serializeMessagesToResponsesInputWithLimits(limitedModel, [{
				role: "user", content: [image, image], timestamp: 2,
			}]),
		).rejects.toThrow("per message");
		const requestLimitedModel: Model<"openai-responses"> = {
			...limitedModel,
			inputLimits: { images: { maxPerMessage: 2, maxPerRequest: 2 } },
		};
		await expect(
			serializeMessagesToResponsesInputWithLimits(requestLimitedModel, [one, {
				role: "user", content: [image, image], timestamp: 3,
			}]),
		).rejects.toThrow("per request");
	});
});

describe("Responses system message serialization", () => {
	test("serializes the leading system prompt as developer text with sections", () => {
		const message = systemMessage("base\uD800", { rules: "rules", removed: null });
		const before = structuredClone(message);
		const input = serializeLlmMessagesToResponsesInput(model, [message]);

		expect(input).toEqual([{ role: "developer", content: "base\n\nrules" }]);
		expect(input.some((item) => item.type === "function_call_output")).toBe(false);
		expect(message).toEqual(before);
	});

	test("renders later system updates as system text for non-reasoning models", () => {
		const input = serializeLlmMessagesToResponsesInput(nonReasoningModel, [
			systemMessage("base", { rules: "initial" }),
			systemMessage("delta\uD800", { rules: "updated", old: null }),
		]);

		expect(input).toEqual([
			{ role: "system", content: "base\n\ninitial" },
			{
				role: "system",
				content:
					'delta\n\nUpdated system prompt section "rules":\n\nupdated\n\nRemoved system prompt section "old".',
			},
		]);
		expect(input.every((item) => item.type !== "function_call_output")).toBe(true);
	});

	test("renders the first message in a sliced post-compaction tail as a system update", () => {
		const input = serializeLlmMessagesToResponsesInput(
			nonReasoningModel,
			[systemMessage("delta\uD800", { rules: "updated", old: null })],
			{ firstSystemMessageIsUpdate: true },
		);

		expect(input).toEqual([
			{
				role: "system",
				content:
					'delta\n\nUpdated system prompt section "rules":\n\nupdated\n\nRemoved system prompt section "old".',
			},
		]);
	});

	test("uses system instead of developer when Responses compat disables the developer role", () => {
		const input = serializeLlmMessagesToResponsesInput(noDeveloperRoleModel, [systemMessage("base")], {
			includeInstructionsInInput: true,
			instructions: "instructions",
		});

		expect(input).toEqual([
			{ role: "system", content: "instructions" },
			{ role: "system", content: "base" },
		]);
	});
});

const grammarModel: Model<"openai-responses"> = {
	...model, compat: { supportsOpenAIGrammarTools: true },
};
function grammarTool(property = "source", variant = "openai_lark"): Tool {
	return {
		name: "script", description: "offline grammar fixture",
		parameters: { type: "object", properties: { [property]: { type: "string" } }, required: [property] } as Tool["parameters"],
		constrainedSampling: { type: "grammar", variants: { [variant]: variant === "openai_regex" ? ".*" : 'start: /.+/' } },
	};
}
function declaration(tool: Tool): Message {
	return { role: "system", content: "", toolsAdded: [tool], timestamp: 1 };
}
function grammarCall(args: Record<string, unknown> = { source: "return 1" }, id = "call_script|ctc_script"): Message {
	return {
		...fauxAssistantMessage(fauxToolCall("script", args, { id }), { stopReason: "toolUse", timestamp: 2 }),
		provider: model.provider, api: model.api, model: model.id,
	};
}
function grammarResult(): Message {
	return { role: "toolResult", toolCallId: "call_script|ctc_script", toolName: "script",
		content: [{ type: "text", text: "1\uD800" }], isError: false, timestamp: 3 };
}
function toolItems(input: readonly unknown[]): unknown[] {
	return input.filter((item) => typeof item === "object" && item !== null &&
		["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes((item as { type: string }).type));
}
function sdkToolItems(messages: Message[], activeModel = grammarModel): unknown[] {
	const normalized = convertToLlm(messages);
	return toolItems(convertResponsesMessages(activeModel, normalizeContext({ messages: normalized }), new Set([model.provider]), {
		grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(normalized), activeModel.compat?.supportsOpenAIGrammarTools === true),
	}));
}

const codexModel: Model<"openai-codex-responses"> = {
	...model, api: "openai-codex-responses",
	compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
		supportsToolSearch: true, supportsStrictMode: true, supportsOpenAIGrammarTools: true },
};

/** Provider buildParams options, not the shared converter's different defaults. */
function sdkEnvelope(messages: Message[], activeModel: Model<Api> = codexModel): unknown[] {
	const normalized = convertToLlm(messages);
	const codex = activeModel.api === "openai-codex-responses";
	const compat = activeModel.compat as {
		supportsAdditionalTools?: boolean; supportsToolSearch?: boolean;
		supportsStrictMode?: boolean; supportsOpenAIGrammarTools?: boolean;
	} | undefined;
	return convertResponsesMessages(activeModel, normalizeContext({ messages: normalized }), new Set([activeModel.provider]), {
		includeSystemPrompt: !codex,
		supportsMidConvoSystemMessages: true,
		supportsAdditionalTools: compat?.supportsAdditionalTools === true,
		supportsToolSearch: compat?.supportsToolSearch === true,
		grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(normalized), compat?.supportsOpenAIGrammarTools === true),
		toolOptions: { ...(codex ? { strict: null } : {}),
			supportsStrictMode: compat?.supportsStrictMode ?? codex,
			supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools === true },
	});
}

function plainTool(name: string): Tool {
	return { name, description: name, parameters: { type: "object", properties: {} } as Tool["parameters"] };
}
function sameModelText(blocks: Array<{ type: "text"; text: string; textSignature?: string }>, activeModel: Model<Api> = codexModel): Message {
	return { ...fauxAssistantMessage(blocks, { timestamp: 10 }), provider: activeModel.provider,
		api: activeModel.api, model: activeModel.id };
}

describe("normal request envelope SDK parity", () => {
	test("Codex excludes only the leading system; ordinary Responses includes it", () => {
		const messages = [systemMessage("initial", { rules: "initial rule" }),
			{ role: "user", content: "question", timestamp: 1 } as Message,
			systemMessage("later", { rules: "new rule", gone: null }),
			sameModelText([{ type: "text", text: "unsigned" }])];
		const before = structuredClone(messages);
		const actual = serializeLlmMessagesToResponsesInput(codexModel, messages);
		expect(actual).toEqual(sdkEnvelope(messages));
		expect(actual[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "question" }] });
		expect(actual[1]).toEqual({ role: "developer", content: 'later\n\nUpdated system prompt section "rules":\n\nnew rule\n\nRemoved system prompt section "gone".' });
		expect(actual[2]).toMatchObject({ id: "msg_pi_2" });
		const ordinary = { ...model, compat: { ...codexModel.compat } };
		const ordinaryMessages = [...messages.slice(0, -1), sameModelText([{ type: "text", text: "unsigned" }], ordinary)];
		expect(serializeLlmMessagesToResponsesInput(ordinary, ordinaryMessages)).toEqual(sdkEnvelope(ordinaryMessages, ordinary));
		expect(serializeLlmMessagesToResponsesInput(ordinary, ordinaryMessages)[0]).toEqual({ role: "developer", content: "initial\n\ninitial rule" });
		expect(messages).toEqual(before);
	});

	test("empty updates count; text blocks get unique IDs while signed IDs and phases survive", () => {
		const messages = [systemMessage("initial"), { role: "user", content: "question", timestamp: 1 } as Message,
			systemMessage(""), sameModelText([
				{ type: "text", text: "first" },
				{ type: "text", text: "signed", textSignature: JSON.stringify({ v: 1, id: "msg_signed", phase: "commentary" }) },
				{ type: "text", text: "third" },
				{ type: "text", text: "final", textSignature: JSON.stringify({ v: 1, id: "long".repeat(30), phase: "final_answer" }) },
			])];
		const actual = serializeLlmMessagesToResponsesInput(codexModel, messages);
		expect(actual).toEqual(sdkEnvelope(messages));
		expect(actual.slice(1, 4).map((item) => item.id)).toEqual(["msg_pi_2", "msg_signed", "msg_pi_2_2"]);
		expect(actual[2]).toMatchObject({ phase: "commentary" });
		expect(actual[4]).toMatchObject({ phase: "final_answer" });
	});

	test("positioned plain/strict/grammar declarations precede their later system text", () => {
		const strict = { ...plainTool("strict"), parameters: { type: "object", properties: {
			value: { type: "string" }, optional: { type: "array", items: { type: "number" } },
			nested: { type: "object", properties: { flag: { type: "boolean" } } },
		}, required: ["value"] }, constrainedSampling: { type: "json_schema", strict: "require" } } as Tool;
		const grammar = grammarTool();
		grammar.constrainedSampling = { type: "grammar", variants: { openai_lark: "start: /.+/", openai_regex: ".*" } };
		const messages: Message[] = [declaration(plainTool("initial")), { role: "user", content: "question", timestamp: 1 },
			{ role: "system", content: "positioned text", toolsAdded: [plainTool("plain"), strict, grammar], timestamp: 2 },
			sameModelText([{ type: "text", text: "unsigned" }])];
		const before = structuredClone(messages);
		const actual = serializeLlmMessagesToResponsesInput(codexModel, messages);
		expect(actual).toEqual(sdkEnvelope(messages));
		expect(actual[1]).toEqual({ type: "additional_tools", role: "developer", tools: [
			{ type: "function", name: "plain", description: "plain", parameters: { type: "object", properties: {} }, strict: null },
			{ type: "function", name: "strict", description: "strict", strict: true, parameters: {
				type: "object", properties: { value: { type: "string" },
					optional: { anyOf: [{ type: "array", items: { type: "number" } }, { type: "null" }] },
					nested: { anyOf: [{ type: "object", properties: { flag: { anyOf: [{ type: "boolean" }, { type: "null" }] } }, required: ["flag"], additionalProperties: false }, { type: "null" }] },
				}, required: ["value", "optional", "nested"], additionalProperties: false,
			} },
			{ type: "custom", name: "script", description: "offline grammar fixture", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
		] });
		expect(actual[2]).toEqual({ role: "developer", content: "positioned text" });
		expect(actual[3]).toMatchObject({ id: "msg_pi_2" });
		expect(resolveTranscriptTools(messages, true).requestTools).toEqual([plainTool("initial")]);
		expect(messages).toEqual(before);
	});

	for (const change of [
		{ toolsRemoved: [{ name: "later" }] },
		{ toolsAdded: [plainTool("later")] },
		{ toolsAdded: [{ ...plainTool("later"), description: "changed" }] },
	]) test(`any full-history non-additive change disables all additions: ${JSON.stringify(change)}`, () => {
		const messages: Message[] = [declaration(plainTool("initial")),
			{ role: "user", content: "question", timestamp: 1 },
			{ role: "system", content: "addition text", toolsAdded: [plainTool("later")], timestamp: 2 },
			{ role: "system", content: "change text", ...change, timestamp: 3 }];
		const actual = serializeLlmMessagesToResponsesInput(codexModel, messages);
		expect(actual).toEqual(sdkEnvelope(messages));
		expect(actual).toEqual([{ role: "user", content: [{ type: "input_text", text: "question" }] },
			{ role: "developer", content: "addition text" }, { role: "developer", content: "change text" }]);
		const current = resolveTranscriptTools(messages, true);
		expect(current.anchorsAdditions).toBe(false);
		expect(current.requestTools).toEqual(change.toolsRemoved ? [plainTool("initial")] : [plainTool("initial"), change.toolsAdded![0]]);
	});

	test("strict prefer falls back; strict require fails closed without mutating declarations", () => {
		const unsupported = { ...plainTool("bad"), parameters: { type: "object", additionalProperties: true },
			constrainedSampling: { type: "json_schema", strict: "prefer" } } as Tool;
		for (const activeModel of [codexModel, { ...model, compat: { ...codexModel.compat, supportsStrictMode: false } }]) {
			const messages: Message[] = [systemMessage("initial"), declaration(unsupported)];
			const before = structuredClone(messages);
			expect(serializeLlmMessagesToResponsesInput(activeModel, messages)).toEqual(sdkEnvelope(messages, activeModel));
			unsupported.constrainedSampling = { type: "json_schema", strict: "require" };
			expect(() => serializeLlmMessagesToResponsesInput(activeModel, messages)).toThrow(ToolDeclarationSerializationError);
			unsupported.constrainedSampling = { type: "json_schema", strict: "prefer" };
			expect(messages).toEqual(before);
		}
	});

	for (const parameters of [
		{ type: "object", properties: { nullable: { type: ["string", "null"] }, value: { enum: ["x", null] } } },
		{ type: "object", properties: { choice: { anyOf: [{ type: "string" }, { type: "number" }] } }, required: ["choice"], additionalProperties: false },
	]) test(`strict nullable and primitive-union schemas match SDK: ${JSON.stringify(parameters)}`, () => {
		const tool = { ...plainTool("schema"), parameters, constrainedSampling: { type: "json_schema", strict: "require" } } as Tool;
		const messages = [systemMessage("initial"), declaration(tool)];
		const before = structuredClone(messages);
		expect(serializeLlmMessagesToResponsesInput(codexModel, messages)).toEqual(sdkEnvelope(messages));
		expect(messages).toEqual(before);
	});

	for (const parameters of [true, { type: "string" }, { type: "object", required: ["unknown"] },
		{ type: "object", required: [123] }, { type: "object", properties: [] },
		{ type: "object", additionalProperties: { type: "string" } },
		{ type: "object", properties: { value: { $ref: "#/$defs/Value" } } },
		{ type: "object", properties: { value: { anyOf: [] } } },
		{ type: "object", properties: { value: { anyOf: [{ type: "object" }] } } },
		{ type: "object", properties: { value: { type: "array", items: [{ type: "string" }] } } },
	]) test(`strict invalid schema require refuses and prefer preserves SDK fallback: ${JSON.stringify(parameters)}`, () => {
		const tool = { ...plainTool("schema"), parameters, constrainedSampling: { type: "json_schema", strict: "require" } } as Tool;
		const messages = [systemMessage("initial"), declaration(tool)];
		const before = structuredClone(messages);
		expect(() => serializeLlmMessagesToResponsesInput(codexModel, messages)).toThrow(ToolDeclarationSerializationError);
		expect(() => sdkEnvelope(messages)).toThrow();
		expect(messages).toEqual(before);
		tool.constrainedSampling = { type: "json_schema", strict: "prefer" };
		expect(serializeLlmMessagesToResponsesInput(codexModel, messages)).toEqual(sdkEnvelope(messages));
	});

	test("search-only positioned additions explicitly refuse, additive-disabled cases remain supported", () => {
		const searchOnly = { ...codexModel, compat: { ...codexModel.compat, supportsAdditionalTools: false } };
		const messages = [declaration(plainTool("initial")), declaration(plainTool("later"))];
		expect(() => serializeLlmMessagesToResponsesInput(searchOnly, messages)).toThrow(ToolDeclarationSerializationError);
		expect(serializeLlmMessagesToResponsesInput(searchOnly, [messages[0]])).toEqual([]);
		expect(serializeLlmMessagesToResponsesInput(searchOnly, [...messages,
			{ role: "system", content: "", toolsRemoved: [{ name: "later" }], timestamp: 3 }])).toEqual([]);
	});

	test("system updates between a call and real results wait for the whole batch, with no duplicate synthetic result", () => {
		const batch = { ...assistant(), api: codexModel.api } as Message;
		const messages = [systemMessage("initial"), batch, result(0), systemMessage("update"), result(1)];
		const actual = serializeLlmMessagesToResponsesInput(codexModel, messages);
		expect(actual).toEqual(sdkEnvelope(messages));
		expect(actual.map((item) => item.type ?? item.role)).toEqual(["function_call", "function_call", "function_call_output", "function_call_output", "developer"]);
		expect(JSON.stringify(actual)).not.toContain("No result provided");
	});

	test("same-model call/result IDs and namespaces survive both function and grammar serialization", () => {
		const call = grammarCall();
		if (call.role !== "assistant" || call.content[0].type !== "toolCall") throw new Error("fixture");
		call.api = codexModel.api;
		call.content[0].namespace = "fixture_namespace";
		const messages = [declaration(grammarTool()), call, grammarResult()];
		expect(serializeLlmMessagesToResponsesInput(codexModel, messages)).toEqual(sdkEnvelope(messages));
		expect(serializeLlmMessagesToResponsesInput(codexModel, messages)[0]).toMatchObject({ id: "ctc_script", call_id: "call_script", namespace: "fixture_namespace" });
		const plain = { ...codexModel, compat: { ...codexModel.compat, supportsOpenAIGrammarTools: false } };
		call.content[0].id = "call_script|fc_script";
		expect(serializeLlmMessagesToResponsesInput(plain, messages)).toEqual(sdkEnvelope(messages, plain));
	});
});

describe("Responses persisted grammar compatibility", () => {
	for (const [variant, property] of [["openai_lark", "source"], ["openai_regex", "expression"], ["openai_lark", "code"]]) {
		test(`${variant}/${property}: persisted removed declaration matches SDK without scratch customInput`, () => {
			const messages: Message[] = JSON.parse(JSON.stringify([
				declaration(grammarTool(property, variant)), grammarCall({ [property]: "return 1\uD800" }), grammarResult(),
				{ role: "system", content: "", toolsRemoved: [{ name: "script" }], timestamp: 4 },
			]));
			const before = structuredClone(messages);
			expect(getGrammarToolInputProperties(grammarModel, messages)).toEqual(new Map([["script", property]]));
			const actual = toolItems(serializeMessagesToResponsesInput(grammarModel, messages));
			expect(actual).toEqual([
				{ type: "custom_tool_call", id: "ctc_script", call_id: "call_script", name: "script", input: "return 1" },
				{ type: "custom_tool_call_output", call_id: "call_script", output: "1" },
			]);
			expect(actual).toEqual(sdkToolItems(messages));
			expect(serializeLlmMessagesToResponsesInput(grammarModel, messages)).toEqual(serializeMessagesToResponsesInput(grammarModel, messages));
			expect(JSON.stringify(messages)).not.toContain("customInput");
			expect(messages).toEqual(before);
		});
	}

	test("uses SDK last-declaration semantics, lark priority and permits optional properties", () => {
		const first = grammarTool("old");
		const last = grammarTool("expression", "openai_regex");
		last.parameters.properties!.optional = { type: "number" };
		last.constrainedSampling = { type: "grammar", variants: { openai_lark: "start: /.+/", openai_regex: ".*" } };
		const messages = [declaration(first), declaration(last), grammarCall({ expression: "x" }), grammarResult()];
		expect(getGrammarToolInputProperties(grammarModel, messages)).toEqual(new Map([["script", "expression"]]));
		expect(toolItems(serializeMessagesToResponsesInput(grammarModel, messages))).toEqual(sdkToolItems(messages));
	});

	for (const compat of [undefined, { supportsOpenAIGrammarTools: false }]) {
		test(`compat ${JSON.stringify(compat)} ignores grammar metadata and drops only custom IDs`, () => {
			const fallbackModel = { ...model, compat };
			const messages = [declaration(grammarTool()), grammarCall(), grammarResult(), assistant(), result(0), result(1)];
			const input = toolItems(serializeMessagesToResponsesInput(fallbackModel, messages, {
				grammarToolInputProperties: new Map([["script", "source"]]),
			}));
			expect(getGrammarToolInputProperties(fallbackModel, messages).size).toBe(0);
			expect(input[0]).toEqual({ type: "function_call", id: undefined, call_id: "call_script", name: "script", arguments: '{"source":"return 1"}' });
			expect(input[1]).toEqual({ type: "function_call_output", call_id: "call_script", output: "1" });
			expect(input[2]).toMatchObject({ type: "function_call", id: "fc_a" });
			expect(input.some((item) => (item as { type: string }).type.startsWith("custom_"))).toBe(false);
		});
	}

	test("plain functions retain legacy IDs even with grammar compat enabled", () => {
		const plain = grammarTool();
		delete plain.constrainedSampling;
		const input = toolItems(serializeMessagesToResponsesInput(grammarModel, [declaration(plain), grammarCall({}, "call_plain|legacy_id")]));
		expect(input).toEqual([
			{ type: "function_call", id: "legacy_id", call_id: "call_plain", name: "script", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_plain", output: "No result provided" },
		]);
	});

	for (const id of ["call_script|fc_wrong", "call_script|foreign", "call_script"]) {
		test(`custom ID guard ${id} preserves call_id`, () => {
			const messages = [declaration(grammarTool()), grammarCall({ source: "x" }, id)];
			const input = toolItems(serializeMessagesToResponsesInput(grammarModel, messages));
			expect(input).toEqual([
				{ type: "custom_tool_call", id: undefined, call_id: "call_script", name: "script", input: "x" },
				{ type: "custom_tool_call_output", call_id: "call_script", output: "No result provided" },
			]);
		});
	}

	test("mixed custom/function real and synthetic outputs use one historical map", () => {
		const messages = [declaration(grammarTool()), grammarCall(), grammarResult(), assistant(), result(0), grammarCall()];
		const input = serializeMessagesToResponsesInput(grammarModel, messages);
		expect(toolItems(input)).toEqual(sdkToolItems(messages));
		expect(createResponsesInputParitySignature(input)).toEqual([
			"custom_tool_call:script", "custom_tool_call_output", "function_call:read", "function_call:read",
			"function_call_output", "function_call_output", "custom_tool_call:script", "custom_tool_call_output",
		]);
	});

	const invalidDeclarations = [
		{ parameters: { type: "string" } },
		{ parameters: { type: "object", properties: { source: { type: "string" } } } },
		{ parameters: { type: "object", properties: { source: { type: "string" } }, required: [] } },
		{ parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source", "other"] } },
		{ parameters: { type: "object", properties: {}, required: ["secret-property"] } },
		{ parameters: { type: "object", properties: { source: { type: "number" } }, required: ["source"] } },
		{ parameters: { type: "object", properties: {}, required: [123] } },
		{ constrainedSampling: { type: "grammar", variants: {} } },
		{ constrainedSampling: { type: "grammar", variants: { openai_lark: " \n", openai_regex: "" } } },
		{ constrainedSampling: { type: "grammar", variants: null } },
	];
	for (const [index, invalid] of invalidDeclarations.entries()) {
		test(`invalid eligible declaration ${index} refuses with content-free error`, () => {
			const messages = [declaration({ ...grammarTool(), ...invalid, name: "secret-tool" } as Tool)];
			expect(() => serializeMessagesToResponsesInput(grammarModel, messages)).toThrow(GrammarToolSerializationError);
			expect(() => serializeMessagesToResponsesInput(grammarModel, messages)).toThrow("Invalid OpenAI grammar tool declaration.");
			expect(() => getGrammarToolInputProperties(grammarModel, messages)).toThrow("Invalid OpenAI grammar tool declaration.");
			expect(() => serializeMessagesToResponsesInput(model, messages)).not.toThrow();
		});
	}
	for (const args of [{}, { source: 12 }, { source: null }, { source: { secret: "payload" } }]) {
		test(`invalid grammar input ${JSON.stringify(args)} refuses without leaking content`, () => {
			const messages = [declaration(grammarTool()), grammarCall(args)];
			expect(() => serializeMessagesToResponsesInput(grammarModel, messages)).toThrow(GrammarToolSerializationError);
			expect(() => serializeMessagesToResponsesInput(grammarModel, messages)).toThrow("Invalid OpenAI grammar tool input.");
		});
	}

	test("full-context metadata supports sliced tails, including empty string inputs", () => {
		const full = [declaration(grammarTool("expression")), grammarCall({ expression: "" }), grammarResult()];
		const properties = getGrammarToolInputProperties(grammarModel, full);
		expect(toolItems(serializeMessagesToResponsesInput(grammarModel, full.slice(1), { grammarToolInputProperties: properties })))
			.toEqual(sdkToolItems(full));
		expect(properties).toEqual(new Map([["script", "expression"]]));
	});

	test("custom output images preserve text and enforce message/request limits", async () => {
		const image = { type: "image" as const, data: "AQ==", mimeType: "image/png" };
		const result = grammarResult();
		if (result.role !== "toolResult") throw new Error("fixture");
		result.content.push(image);
		const messages = [declaration(grammarTool()), grammarCall(), result];
		const before = structuredClone(messages);
		const imageModel: Model<"openai-responses"> = {
			...grammarModel, input: ["text", "image"], inputLimits: { images: { maxPerMessage: 1, maxPerRequest: 1 } },
		};
		const input = await serializeMessagesToResponsesInputWithLimits(imageModel, messages);
		expect(input[1]).toEqual({ type: "custom_tool_call_output", call_id: "call_script", output: [
			{ type: "input_text", text: "1" }, { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AQ==" },
		] });
		expect(toolItems(input)).toEqual(sdkToolItems(messages, imageModel));
		expect(messages).toEqual(before);
		await expect(serializeMessagesToResponsesInputWithLimits(imageModel, [...messages, { role: "user", content: [image], timestamp: 4 }])).rejects.toThrow("per request");
		result.content.push(image);
		await expect(serializeMessagesToResponsesInputWithLimits(imageModel, messages)).rejects.toThrow("per message");
		expect(toolItems(serializeMessagesToResponsesInput(grammarModel, messages))[1]).toEqual({ type: "custom_tool_call_output", call_id: "call_script", output: "1" });
	});
});
