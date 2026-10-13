import type { ResponsesCompatibleRequestPayload } from "./runtime-core";
import { LOCAL_WEB_SEARCH_TOOL_NAME, WEB_RUN_TOOL_NAME } from "./web-search/types";
export type CompactionRequestExtras = {
	tools?: unknown[];
	parallel_tool_calls?: boolean;
	reasoning?: Record<string, unknown>;
	service_tier?: string;
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	prompt_cache_options?: Record<string, unknown>;
	text?: Record<string, unknown>;
};
export type RequestContextIdentity = { provider: string; api: string; model: string; baseUrl: string; sessionId?: string };
export type RequestContextCaptureOptions = { excludeWebSearchTools?: boolean };
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isWebSearchTool(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type === "web_search" || value.type === "web_search_preview") return true;
	return value.type === "function" && (value.name === LOCAL_WEB_SEARCH_TOOL_NAME || value.name === WEB_RUN_TOOL_NAME);
}
function sameIdentity(left: RequestContextIdentity, right: RequestContextIdentity): boolean {
	return left.provider === right.provider && left.api === right.api && left.model === right.model
		&& left.baseUrl === right.baseUrl && left.sessionId === right.sessionId;
}
/** Exact-identity slot owned by one activation, including identities without a session id. */
export function createRequestContextCache() {
	let cached: { identity: RequestContextIdentity; extras: CompactionRequestExtras } | undefined;
	function rememberRequestContext(payload: ResponsesCompatibleRequestPayload, identity: RequestContextIdentity,
		options: RequestContextCaptureOptions = {}): void {
		try {
			if (payload.model !== identity.model) { cached = undefined; return; }
			const extras: CompactionRequestExtras = {};
			if (Array.isArray(payload.tools)) extras.tools = structuredClone(options.excludeWebSearchTools
				? payload.tools.filter((tool) => !isWebSearchTool(tool)) : payload.tools);
			if (typeof payload.parallel_tool_calls === "boolean") extras.parallel_tool_calls = payload.parallel_tool_calls;
			if (isRecord(payload.reasoning)) extras.reasoning = structuredClone(payload.reasoning);
			if (typeof payload.service_tier === "string" && payload.service_tier.trim().length > 0) extras.service_tier = payload.service_tier;
			if (typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0) extras.prompt_cache_key = payload.prompt_cache_key;
			if (payload.prompt_cache_retention === "in_memory" || payload.prompt_cache_retention === "24h") extras.prompt_cache_retention = payload.prompt_cache_retention;
			if (isRecord(payload.prompt_cache_options)) extras.prompt_cache_options = structuredClone(payload.prompt_cache_options);
			if (isRecord(payload.text)) extras.text = structuredClone(payload.text);
			cached = { identity: structuredClone(identity), extras };
		} catch { cached = undefined; }
	}
	function getCompactionRequestExtras(identity: RequestContextIdentity, producer?: { api: string; compat?: unknown }): CompactionRequestExtras | undefined {
		if (!cached || !sameIdentity(cached.identity, identity)) return undefined;
		try {
			const extras = structuredClone(cached.extras);
			if (producer) {
				const compat = isRecord(producer.compat) ? producer.compat : {};
				if (producer.api !== "openai-responses") { delete extras.prompt_cache_options; delete extras.prompt_cache_retention; }
				else {
					if (compat.supportsExplicitPromptCacheMode === true) delete extras.prompt_cache_retention;
					else delete extras.prompt_cache_options;
					if (compat.supportsLongCacheRetention === false) {
						if (extras.prompt_cache_options?.ttl !== undefined) delete extras.prompt_cache_options;
						if (extras.prompt_cache_retention === "24h") delete extras.prompt_cache_retention;
					}
				}
			}
			return extras;
		} catch { return undefined; }
	}
	function clearRequestContextCache(): void { cached = undefined; }
	return { rememberRequestContext, getCompactionRequestExtras, clearRequestContextCache };
}
export type RequestContextCache = ReturnType<typeof createRequestContextCache>;
