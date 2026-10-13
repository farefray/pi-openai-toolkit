/** Upstream compatibility slot; the safe entrypoint imports only the closure factory. */
import { createRequestContextCache } from "./request-context-cache-core";
export * from "./request-context-cache-core";
const upstreamCache = createRequestContextCache();
export const rememberRequestContext = upstreamCache.rememberRequestContext;
export const getCompactionRequestExtras = upstreamCache.getCompactionRequestExtras;
export const clearRequestContextCache = upstreamCache.clearRequestContextCache;
