import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, getDeclaredTools, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
// SDK internals are a parity oracle only; production uses public getDeclaredTools.
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	GrammarToolSerializationError,
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
	return toolItems(convertResponsesMessages(activeModel, { messages: normalized }, new Set([model.provider]), {
		grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(normalized), activeModel.compat?.supportsOpenAIGrammarTools === true),
	}));
}

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
