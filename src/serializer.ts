import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import { getDeclaredTools, getSystemMessageText, renderSystemMessageUpdate, normalizeContext, resolveTranscript, resolveTranscriptTools } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ResponsesCompatibleRequestPayload } from "./runtime";
import type { CompactionRequestExtras } from "./request-context-cache";

/**
 * pi stopped exporting the CompactionPreparation type name in 0.80.x, but it is still
 * structurally the first argument of the exported compact(). Derive it from there so we
 * track pi's shape without depending on a private export.
 */
type CompactionPreparation = Parameters<typeof compact>[0];

/**
 * Decision for T4: keep a narrow local serializer instead of importing Pi internals.
 *
 * Why this is sufficient for v1:
 * - we only target same-model OpenAI Responses-compatible requests
 * - we only need Pi's current supported message semantics (assistant phase,
 *   reasoning signatures, tool call/result pairing, image blocks)
 * - Pi 1.3 exports the shared converter through an API subpath, but the host's
 *   jiti root alias currently redirects that subpath to compat.js. Use working
 *   public root transcript/text helpers, not a loader or install-path bypass.
 *
 * The helpers below intentionally mirror Pi's same-model Responses serialization
 * rules closely so later tasks can compare their output against captured
 * before_provider_request payload artifacts.
 */
export const COMPACTION_SERIALIZER_STRATEGY = "local-same-model-responses-serializer" as const;

export type CompactionSerializerStrategy = typeof COMPACTION_SERIALIZER_STRATEGY;
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
	type: "input_text";
	text: string;
};

type ResponsesImageInputItem = {
	type: "input_image";
	detail: "auto";
	image_url: string;
};

export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
	role: "user" | "developer" | "system";
	content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
	type: "message";
	role: "assistant";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: [];
	}>;
	status: "completed";
	id: string;
	phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
	namespace?: string;
};

export type ResponsesFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesCustomToolCallItem = {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	input: string;
	namespace?: string;
};

export type ResponsesCustomToolCallOutputItem = {
	type: "custom_tool_call_output";
	call_id: string;
	output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

/**
 * Pi 0.86 adds `SystemMessage` to the public `Message` union; 0.85.1 has no system
 * variant and does not export that type name. Use the public shape when the installed
 * Pi declares it and a structural fallback for the fields this serializer consumes
 * otherwise, so one source file type-checks against both supported versions.
 */
type ResponsesSystemMessage = Extract<Message, { role: "system" }> extends never
	? {
			role: "system";
			content: string | TextContent[];
			sections?: Record<string, string | null>;
			timestamp: number;
		}
	: Extract<Message, { role: "system" }>;

export type ResponsesInputItem =
	| ResponsesInputMessageItem
	| ResponsesAssistantOutputItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem
	| ResponsesCustomToolCallItem
	| ResponsesCustomToolCallOutputItem
	| ResponsesReasoningItem;

/** The synthetic request shares the live-request extras allowlist. */
export type NativeCompactionRequestBody = CompactionRequestExtras & {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
};

export type SerializeResponsesMessagesOptions = {
	instructions?: string;
	includeInstructionsInInput?: boolean;
	/** Treat a system message at the start of a sliced post-compaction tail as an update. */
	firstSystemMessageIsUpdate?: boolean;
	/** Derived from the full projected transcript when serializing a sliced tail. */
	grammarToolInputProperties?: ReadonlyMap<string, string>;
};

export type ResponsesParityReport = {
	ok: boolean;
	actual: string[];
	expected: string[];
	mismatches: string[];
};

type ParsedTextSignature = {
	id: string;
	phase?: AssistantPhase;
};

const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function instructionRole<TApi extends Api>(model: Model<TApi>): "developer" | "system" {
	// Pi's public Model compat union is broader than the OpenAI Responses compat
	// shape, while the runtime field is shared by both supported Pi versions.
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	return model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
}

/** Declaration refusals must cancel compaction, not delegate through a swallowed hook error. */
export class ToolDeclarationSerializationError extends Error {
	constructor() {
		super("Invalid OpenAI tool declaration or unsupported tool transport.");
		this.name = "ToolDeclarationSerializationError";
	}
}

export class GrammarToolSerializationError extends ToolDeclarationSerializationError {
	constructor(kind: "declaration" | "input") {
		super();
		this.message = `Invalid OpenAI grammar tool ${kind}.`;
		this.name = "GrammarToolSerializationError";
	}
}

/** Resolve historical declarations, including tools removed from the current loadout. */
export function getGrammarToolInputProperties<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
): ReadonlyMap<string, string> {
	return getLlmGrammarToolInputProperties(model, convertToLlm(messages));
}

function getLlmGrammarToolInputProperties<TApi extends Api>(
	model: Model<TApi>,
	messages: Message[],
): ReadonlyMap<string, string> {
	const properties = new Map<string, string>();
	if (!supportsGrammarTools(model)) return properties;

	for (const tool of getDeclaredTools(messages)) {
		const config = tool.constrainedSampling;
		if (!config || config.type !== "grammar") continue;
		const variants = config.variants;
		const hasVariant = [variants?.openai_lark, variants?.openai_regex].some(
			(value) => typeof value === "string" && value.trim().length > 0,
		);
		const schema = tool.parameters as {
			type?: unknown;
			required?: unknown;
			properties?: Record<string, { type?: unknown }>;
		};
		// Mirror SDK inferGrammarInputProperty: exactly one required string property;
		// optional properties do not prevent use of the grammar input property.
		const required = schema?.required;
		const property = Array.isArray(required) && required.length === 1 ? required[0] : undefined;
		if (
			!hasVariant || schema?.type !== "object" || typeof property !== "string" ||
			schema.properties?.[property]?.type !== "string"
		) {
			throw new GrammarToolSerializationError("declaration");
		}
		properties.set(tool.name, property);
	}
	return properties;
}

function supportsGrammarTools<TApi extends Api>(model: Model<TApi>): boolean {
	return (model.compat as { supportsOpenAIGrammarTools?: boolean } | undefined)?.supportsOpenAIGrammarTools === true;
}

/**
 * Narrow pure adaptation of pi-ai 1.3 api/constrained-sampling.js and
 * convertResponsesTools (https://github.com/earendil-works/pi), MIT.
 * Copyright (c) 2025 Mario Zechner. Permission is hereby granted, free of charge,
 * to any person obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom
 * the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
 * THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * Only declaration conversion/strict schema rules are adapted, not SDK streaming.
 */
function serializeToolDeclarations<TApi extends Api>(model: Model<TApi>, tools: Tool[]): Record<string, unknown>[] {
	const codex = model.api === "openai-codex-responses";
	const supportsStrict = (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode ?? codex;
	return tools.map((tool) => {
		const config = tool.constrainedSampling;
		if (config && config.type === "grammar" && supportsGrammarTools(model)) {
			// Use the same validation as historical call serialization.
			getLlmGrammarToolInputProperties(model, [{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 }]);
			const lark = config.variants.openai_lark;
			return { type: "custom", name: tool.name, description: tool.description,
				format: { type: "grammar", syntax: typeof lark === "string" && lark.trim() ? "lark" : "regex",
					definition: typeof lark === "string" && lark.trim() ? lark : config.variants.openai_regex } };
		}
		let strict: boolean | null = codex ? null : false;
		let parameters = tool.parameters;
		if (config && config.type === "json_schema") {
			if (supportsStrict) {
				try {
					parameters = makeStrictToolSchema(tool.parameters) as Tool["parameters"];
					strict = true;
				} catch (error) {
					if (!(error instanceof ToolDeclarationSerializationError)) throw error;
					if (config.strict === "require") throw error;
				}
			} else if (config.strict === "require") throw new ToolDeclarationSerializationError();
		}
		return { type: "function", name: tool.name, description: tool.description, parameters,
			...(supportsStrict ? { strict } : {}) };
	});
}

function schemaRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!schemaRecord(schema)) return false;
	return schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) ||
		schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null)) ||
		(Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAllowsNull));
}

function makeStrictToolSchema(schema: unknown): Record<string, unknown> {
	const cloned: unknown = structuredClone(schema);
	makeSchemaNodeStrict(cloned);
	if (!schemaRecord(cloned) || cloned.type !== "object") throw new ToolDeclarationSerializationError();
	return cloned;
}

function makeSchemaNodeStrict(schema: unknown): asserts schema is Record<string, unknown> {
	if (!schemaRecord(schema)) throw new ToolDeclarationSerializationError();
	for (const key of ["$ref", "$defs", "definitions", "allOf", "oneOf", "patternProperties",
		"dependentSchemas", "dependencies", "unevaluatedProperties", "propertyNames", "contains",
		"prefixItems", "not", "if", "then", "else"]) {
		if (schema[key] !== undefined) throw new ToolDeclarationSerializationError();
	}
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new ToolDeclarationSerializationError();
		for (const variant of schema.anyOf) {
			if (schemaRecord(variant)) {
				const types = Array.isArray(variant.type) ? variant.type : [variant.type];
				if (types.includes("object") || types.includes("array") || variant.properties !== undefined || variant.items !== undefined) {
					throw new ToolDeclarationSerializationError();
				}
			}
			makeSchemaNodeStrict(variant);
		}
	}
	if (schema.items !== undefined) makeSchemaNodeStrict(schema.items);
	if (schema.properties !== undefined && schema.type !== "object") throw new ToolDeclarationSerializationError();
	if (schema.type !== "object") return;
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new ToolDeclarationSerializationError();
	if (schema.properties !== undefined && !schemaRecord(schema.properties)) throw new ToolDeclarationSerializationError();
	if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
		throw new ToolDeclarationSerializationError();
	}
	const properties = (schema.properties ?? {}) as Record<string, unknown>;
	const names = Object.keys(properties);
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	if ([...required].some((name) => !names.includes(name))) throw new ToolDeclarationSerializationError();
	for (const [name, property] of Object.entries(properties)) {
		makeSchemaNodeStrict(property);
		if (!required.has(name) && !schemaAllowsNull(property)) properties[name] = { anyOf: [property, { type: "null" }] };
	}
	schema.required = names;
	schema.additionalProperties = false;
}

export function collectCompactionWindowMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
}

export function serializeCompactionPreparationToRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	preparation: CompactionPreparation;
	instructions: string;
}): NativeCompactionRequestBody {
	return serializeMessagesToCompactRequest({
		model: args.model,
		messages: collectCompactionWindowMessages(args.preparation),
		instructions: args.instructions,
	});
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): NativeCompactionRequestBody {
	return {
		model: args.model.id,
		input: serializeMessagesToResponsesInput(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

/**
 * Async compaction serializer used by live synthetic requests. Pi exposes model
 * image limits and newer versions expose a public resize helper; keep the
 * historical sync API for callers/tests while applying those limits only at the
 * actual request edge.
 */
export async function serializeMessagesToCompactRequestWithLimits<TApi extends Api>(args: {
	model: Model<TApi>;
	messages: AgentMessage[];
	instructions: string;
}): Promise<NativeCompactionRequestBody> {
	return {
		model: args.model.id,
		input: await serializeMessagesToResponsesInputWithLimits(args.model, args.messages),
		instructions: sanitizeSurrogates(args.instructions),
	};
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	return serializeLlmMessagesToResponsesInput(model, convertToLlm(messages), options);
}

export async function serializeMessagesToResponsesInputWithLimits<TApi extends Api>(
	model: Model<TApi>,
	messages: AgentMessage[],
	options: SerializeResponsesMessagesOptions = {},
): Promise<ResponsesInputItem[]> {
	return applyModelImageInputLimits(
		model,
		serializeMessagesToResponsesInput(model, messages, options),
	);
}

export async function serializeLlmMessagesToResponsesInputWithLimits<TApi extends Api>(
	model: Model<TApi>,
	messages: Message[],
	options: SerializeResponsesMessagesOptions = {},
): Promise<ResponsesInputItem[]> {
	return applyModelImageInputLimits(
		model,
		serializeLlmMessagesToResponsesInput(model, messages, options),
	);
}

/**
 * Serialize Pi's normalized LLM message union without running `convertToLlm` again.
 * This keeps the system-message boundary directly testable while preserving the public
 * AgentMessage-facing entry point above.
 */
export function serializeLlmMessagesToResponsesInput<TApi extends Api>(
	model: Model<TApi>,
	messages: Message[],
	options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
	const grammarToolInputProperties = supportsGrammarTools(model)
		? options.grammarToolInputProperties ?? getLlmGrammarToolInputProperties(model, messages)
		: new Map<string, string>();
	// Preserve the historical local API's mid-conversation updates unless the
	// model explicitly requires collapsing them. Tail callers keep their first
	// system message as an update rather than inventing an initial prompt.
	const normalized = normalizeContext({ messages });
	const resolved = options.firstSystemMessageIsUpdate ? normalized : resolveTranscript(
		normalized, (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages ?? true,
	);
	const compat = model.compat as {
		supportsAdditionalTools?: boolean; supportsToolSearch?: boolean;
	} | undefined;
	// Decide against the FULL transcript, before transformation or tail selection.
	const transcriptTools = resolveTranscriptTools(messages,
		compat?.supportsAdditionalTools === true || compat?.supportsToolSearch === true);
	// Validate even top-level declarations before dispatch; cached request extras
	// remain authoritative for the actual top-level tools field.
	serializeToolDeclarations(model, transcriptTools.requestTools);
	const transformedMessages = transformMessagesForResponses(resolved.messages);
	const input: ResponsesInputItem[] = [];

	if (options.includeInstructionsInInput && options.instructions) {
		input.push({
			role: instructionRole(model),
			content: sanitizeSurrogates(options.instructions),
		});
	}

	let messageIndex = 0;
	let sourceIndex = 0;
	for (const message of transformedMessages) {
		// Pi 0.85's Message union has no system member, so compare through the
		// public role string while keeping the 0.86 discriminant runtime-compatible.
		const isFirstMessage = sourceIndex++ === 0;
		const isLeadingSystemMessage =
			!options.firstSystemMessageIsUpdate && isFirstMessage && (message.role as string) === "system";

		if (message.role === "user") {
			const item = serializeUserMessage(message, model);
			if (item) {
				input.push(item);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const items = serializeAssistantMessage(message, messageIndex, grammarToolInputProperties, model);
			if (items.length > 0) {
				input.push(...items);
			}
			messageIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			input.push(serializeToolResultMessage(message, model, grammarToolInputProperties));
			messageIndex++;
			continue;
		}

		// In Pi 0.85.1 this branch narrows to `never`; in Pi 0.86 it is a SystemMessage.
		// Handle it explicitly instead of letting a new message variant become tool output.
		if (!isLeadingSystemMessage && transcriptTools.anchorsAdditions && message.toolsAdded?.length) {
			// Search-only transport needs SDK client search IDs/layout. Refuse it
			// explicitly rather than silently losing positioned declarations.
			if (!compat?.supportsAdditionalTools) throw new ToolDeclarationSerializationError();
			input.push({ type: "additional_tools", role: "developer",
				tools: serializeToolDeclarations(model, message.toolsAdded) });
		}
		const systemItem = isLeadingSystemMessage && model.api === "openai-codex-responses"
			? undefined : serializeSystemMessage(message, model, isLeadingSystemMessage);
		if (systemItem) {
			input.push(systemItem);
		}
		if (!isLeadingSystemMessage) {
			messageIndex++;
		}
	}

	return input;
}

type ImageResizeOptions = {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
};

type ModelImageInputLimits = {
	resize?: ImageResizeOptions;
	maxPerMessage?: number;
	maxPerRequest?: number;
};

type ResizeImageResult = {
	data: string;
	mimeType: string;
};

type ResizeImageFunction = (
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
) => Promise<ResizeImageResult | null>;

let resizeImageLoader: Promise<ResizeImageFunction | undefined> | undefined;

function getModelImageInputLimits(model: Model<Api>): ModelImageInputLimits | undefined {
	return (model as Model<Api> & { inputLimits?: { images?: ModelImageInputLimits } }).inputLimits?.images;
}

function readNonNegativeLimit(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Model image input limit ${name} is invalid.`);
	}
	return value;
}

function normalizeResizeOptions(value: unknown): ImageResizeOptions | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const options: ImageResizeOptions = {};
	for (const key of ["maxWidth", "maxHeight", "maxBytes"] as const) {
		const number = candidate[key];
		if (number === undefined) continue;
		if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
			throw new Error(`Model image resize option ${key} is invalid.`);
		}
		options[key] = Math.floor(number);
	}
	if (candidate.jpegQuality !== undefined) {
		if (
			typeof candidate.jpegQuality !== "number" ||
			!Number.isFinite(candidate.jpegQuality) ||
			candidate.jpegQuality <= 0 ||
			candidate.jpegQuality > 100
		) {
			throw new Error("Model image resize option jpegQuality is invalid.");
		}
		options.jpegQuality = candidate.jpegQuality;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

async function loadResizeImage(): Promise<ResizeImageFunction | undefined> {
	resizeImageLoader ??= (async () => {
		try {
			const module = await import("@earendil-works/pi-coding-agent") as {
				resizeImage?: ResizeImageFunction;
			};
			return typeof module.resizeImage === "function" ? module.resizeImage : undefined;
		} catch {
			// Pi 0.87 does not export the helper. The request must fail closed when
			// a newer model explicitly requires a resize rather than sending a
			// potentially oversized image unchanged.
			return undefined;
		}
	})();
	return resizeImageLoader;
}

function inputContentArray(item: ResponsesInputItem): ResponsesInputContentItem[] | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const candidate = item as Record<string, unknown>;
	if (candidate.type === "function_call_output" || candidate.type === "custom_tool_call_output") {
		return Array.isArray(candidate.output) ? candidate.output as ResponsesInputContentItem[] : undefined;
	}
	return Array.isArray(candidate.content) ? candidate.content as ResponsesInputContentItem[] : undefined;
}

function isInputImage(item: ResponsesInputContentItem): item is ResponsesImageInputItem {
	return item.type === "input_image";
}

function decodeDataImage(imageUrl: string): { mimeType: string; bytes: Uint8Array } {
	const separator = imageUrl.indexOf(",");
	const prefix = separator >= 0 ? imageUrl.slice(0, separator) : "";
	if (!prefix.startsWith("data:") || !prefix.endsWith(";base64") || separator < 0) {
		throw new Error("Model image input has an invalid data URL.");
	}
	const mimeType = prefix.slice("data:".length, -";base64".length);
	if (!mimeType) throw new Error("Model image input has no MIME type.");
	return { mimeType, bytes: Buffer.from(imageUrl.slice(separator + 1), "base64") };
}

async function resizeInputImage(
	image: ResponsesImageInputItem,
	options: ImageResizeOptions,
): Promise<ResponsesImageInputItem> {
	const resizeImage = await loadResizeImage();
	if (!resizeImage) {
		throw new Error("The active Pi version cannot resize an image required by model input limits.");
	}
	const source = decodeDataImage(image.image_url);
	const resized = await resizeImage(source.bytes, source.mimeType, options);
	if (!resized || typeof resized.data !== "string" || typeof resized.mimeType !== "string") {
		throw new Error("Model image input could not be resized within the provider limits.");
	}
	return {
		...image,
		image_url: `data:${resized.mimeType};base64,${resized.data}`,
	};
}

/** Enforce Pi's per-message/request image limits without mutating serialized input. */
export async function applyModelImageInputLimits<TApi extends Api>(
	model: Model<TApi>,
	input: ResponsesInputItem[],
): Promise<ResponsesInputItem[]> {
	const limits = getModelImageInputLimits(model);
	if (!limits) return input;

	const maxPerMessage = readNonNegativeLimit(limits.maxPerMessage, "maxPerMessage");
	const maxPerRequest = readNonNegativeLimit(limits.maxPerRequest, "maxPerRequest");
	const resizeOptions = normalizeResizeOptions(limits.resize);
	let requestImageCount = 0;
	const output: ResponsesInputItem[] = [];

	for (const item of input) {
		const content = inputContentArray(item);
		if (!content) {
			output.push(item);
			continue;
		}
		const imageCount = content.filter(isInputImage).length;
		if (maxPerMessage !== undefined && imageCount > maxPerMessage) {
			throw new Error(`Model accepts at most ${maxPerMessage} image(s) per message.`);
		}
		if (maxPerRequest !== undefined && requestImageCount + imageCount > maxPerRequest) {
			throw new Error(`Model accepts at most ${maxPerRequest} image(s) per request.`);
		}
		requestImageCount += imageCount;

		if (!resizeOptions || imageCount === 0) {
			output.push(item);
			continue;
		}
		const resizedContent: ResponsesInputContentItem[] = [];
		for (const contentItem of content) {
			resizedContent.push(isInputImage(contentItem)
				? await resizeInputImage(contentItem, resizeOptions)
				: contentItem);
		}
		const itemRecord = item as Record<string, unknown>;
		if (itemRecord.type === "function_call_output" || itemRecord.type === "custom_tool_call_output") {
			output.push({ ...item, output: resizedContent } as ResponsesInputItem);
		} else {
			output.push({ ...item, content: resizedContent } as ResponsesInputItem);
		}
	}

	return output;
}

export function createResponsesInputParitySignature(input: readonly unknown[]): string[] {
	return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport {
	const actualSignature = createResponsesInputParitySignature(actual);
	const expectedSignature = createResponsesInputParitySignature(expected);
	const maxLength = Math.max(actualSignature.length, expectedSignature.length);
	const mismatches: string[] = [];

	for (let index = 0; index < maxLength; index++) {
		const actualValue = actualSignature[index];
		const expectedValue = expectedSignature[index];
		if (actualValue !== expectedValue) {
			mismatches.push(`index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`);
		}
	}

	return {
		ok: mismatches.length === 0,
		actual: actualSignature,
		expected: expectedSignature,
		mismatches,
	};
}

export function compareCompactRequestToPayload(
	request: NativeCompactionRequestBody,
	payload: Pick<ResponsesCompatibleRequestPayload, "model" | "input" | "instructions">,
): ResponsesParityReport {
	const parity = compareResponsesInputParity(request.input, payload.input);
	const mismatches = [...parity.mismatches];

	if (payload.model !== request.model) {
		mismatches.unshift(`model: expected ${payload.model}, got ${request.model}`);
	}

	if ((payload.instructions ?? "") !== request.instructions) {
		mismatches.unshift("instructions: expected serialized instructions to match payload instructions");
	}

	return {
		ok: mismatches.length === 0,
		actual: parity.actual,
		expected: parity.expected,
		mismatches,
	};
}

function transformMessagesForResponses(messages: Message[]): Message[] {
	const transformed: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const heldSystemMessages: Message[] = [];
	const closePending = () => {
		transformed.push(...createSyntheticToolResults(pendingToolCalls, existingToolResultIds), ...heldSystemMessages);
		pendingToolCalls = [];
		existingToolResultIds = new Set<string>();
		heldSystemMessages.length = 0;
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			closePending();

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}

			const normalizedContent: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type !== "thinking" || block.thinkingSignature) {
					normalizedContent.push(block);
				}
			}

			const normalizedAssistantMessage: AssistantMessage = {
				...message,
				content: normalizedContent,
			};
			transformed.push(normalizedAssistantMessage);

			const toolCalls = normalizedContent.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set<string>();
			}
			continue;
		}

		if (message.role === "toolResult") {
			existingToolResultIds.add(message.toolCallId);
			transformed.push(message);
			continue;
		}

		if (message.role === "system" && pendingToolCalls.length > 0) {
			heldSystemMessages.push(message);
			continue;
		}
		closePending();
		transformed.push(message);
	}

	closePending();
	return transformed;
}

function createSyntheticToolResults(
	pendingToolCalls: readonly ToolCall[],
	existingToolResultIds: ReadonlySet<string>,
): ToolResultMessage[] {
	const syntheticResults: ToolResultMessage[] = [];

	for (const toolCall of pendingToolCalls) {
		if (existingToolResultIds.has(toolCall.id)) {
			continue;
		}

		syntheticResults.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
			isError: true,
			timestamp: Date.now(),
		});
	}

	return syntheticResults;
}

function serializeUserMessage<TApi extends Api>(
	message: UserMessage,
	model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
	const contentItems = normalizeUserContent(message.content).flatMap((item) => serializeUserContentItem(item, model));
	if (contentItems.length === 0) {
		return undefined;
	}

	return {
		role: "user",
		content: contentItems,
	};
}

function serializeUserContentItem<TApi extends Api>(
	item: TextContent | ImageContent,
	model: Model<TApi>,
): ResponsesInputContentItem[] {
	if (item.type === "text") {
		return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
	}

	if (!model.input.includes("image")) {
		return [];
	}

	return [
		{
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		},
	];
}

function serializeAssistantMessage(
	message: AssistantMessage,
	messageIndex: number,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	model: Model<Api>,
): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	const sameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
	let textBlockIndex = 0;

	for (const block of message.content) {
		if (block.type === "thinking") {
			const reasoningItem = parseReasoningItem(block);
			if (reasoningItem) {
				items.push(reasoningItem);
			}
			continue;
		}

		if (block.type === "text") {
			const signature = parseTextSignature(block.textSignature);
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
				status: "completed",
				id: normalizeAssistantMessageId(signature?.id, messageIndex, textBlockIndex++),
				phase: signature?.phase,
			});
			continue;
		}

		const [callId, rawItemId] = block.id.split("|");
		const inputProperty = grammarToolInputProperties.get(block.name);
		if (inputProperty !== undefined) {
			const rawInput = block.arguments?.[inputProperty];
			if (typeof rawInput !== "string") {
				throw new GrammarToolSerializationError("input");
			}
			items.push({
				type: "custom_tool_call",
				id: rawItemId?.startsWith("ctc_") ? rawItemId : undefined,
				call_id: callId,
				name: block.name,
				input: sanitizeSurrogates(rawInput),
				...(sameModel && block.namespace !== undefined ? { namespace: block.namespace } : {}),
			});
			continue;
		}
		items.push({
			type: "function_call",
			id: rawItemId?.startsWith("ctc_") ? undefined : rawItemId,
			call_id: callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
			...(sameModel && block.namespace !== undefined ? { namespace: block.namespace } : {}),
		});
	}

	return items;
}

function serializeToolResultMessage<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
	grammarToolInputProperties: ReadonlyMap<string, string>,
): ResponsesFunctionCallOutputItem | ResponsesCustomToolCallOutputItem {
	const type = grammarToolInputProperties.has(message.toolName) ? "custom_tool_call_output" : "function_call_output";
	const [callId] = message.toolCallId.split("|");
	const textOutput = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	const hasImages = message.content.some((item) => item.type === "image");
	const hasText = textOutput.length > 0;

	if (hasImages && model.input.includes("image")) {
		const output: ResponsesInputContentItem[] = [];
		if (hasText) {
			output.push({ type: "input_text", text: textOutput });
		}
		for (const item of message.content) {
			if (item.type !== "image") {
				continue;
			}
			output.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${item.mimeType};base64,${item.data}`,
			});
		}
		return {
			type,
			call_id: callId,
			output,
		};
	}

	return {
		type,
		call_id: callId,
		output: hasText ? textOutput : "(see attached image)",
	};
}

function normalizeUserContent(content: UserMessage["content"]): Array<TextContent | ImageContent> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Serialize one normalized Pi system message as a Responses input message.
 *
 * The role follows the same reasoning-model convention as `instructions`: reasoning
 * models use `developer`, everything else keeps `system`. Leading messages include
 * their complete section state; later messages use Pi's update framing so section
 * additions/removals are not mistaken for a new complete prompt. An empty system
 * message produces no item, matching Pi.
 */
function serializeSystemMessage<TApi extends Api>(
	message: ResponsesSystemMessage,
	model: Model<TApi>,
	isLeadingSystemMessage: boolean,
): ResponsesInputMessageItem | undefined {
	const text = sanitizeSurrogates(
		isLeadingSystemMessage ? getSystemMessageText(message) : renderSystemMessageUpdate(message),
	);
	if (text.length === 0) {
		return undefined;
	}

	return {
		role: instructionRole(model),
		content: text,
	};
}

function parseReasoningItem(block: ThinkingContent): ResponsesReasoningItem | undefined {
	if (!block.thinkingSignature) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(block.thinkingSignature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as ResponsesReasoningItem;
	} catch {
		return undefined;
	}
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) {
		return undefined;
	}

	if (!signature.startsWith("{")) {
		return { id: signature };
	}

	try {
		const parsed = JSON.parse(signature);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}

		const record = parsed as Record<string, unknown>;
		if (record.v !== 1 || typeof record.id !== "string") {
			return undefined;
		}

		return {
			id: record.id,
			phase:
				record.phase === "commentary" || record.phase === "final_answer"
					? record.phase
					: undefined,
		};
	} catch {
		return undefined;
	}
}

function normalizeAssistantMessageId(id: string | undefined, messageIndex: number, textBlockIndex: number): string {
	if (!id) {
		return textBlockIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textBlockIndex}`;
	}
	if (id.length <= 64) return id;
	return `msg_${shortHash(id)}`;
}

/** Pi utils/hash.js (MIT, Mario Zechner): retain signed long-ID semantics. */
function shortHash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const ch = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function isToolCallBlock(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

function describeResponsesInputItem(item: unknown): string {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return typeof item;
	}

	const record = item as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === "message") {
		const phase =
			record.phase === "commentary" || record.phase === "final_answer"
				? `:${record.phase}`
				: "";
		return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
	}

	if (type === "function_call" || type === "custom_tool_call") {
		return `${type}:${typeof record.name === "string" ? record.name : "unknown"}`;
	}

	if (type === "function_call_output" || type === "custom_tool_call_output") {
		return type;
	}

	if (type === "reasoning") {
		return "reasoning";
	}

	if (typeof record.role === "string") {
		const content = Array.isArray(record.content) ? `[${record.content.length}]` : "";
		return `input:${record.role}${content}`;
	}

	return type ? `item:${type}` : "object";
}
