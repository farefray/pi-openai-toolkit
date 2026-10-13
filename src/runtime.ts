/** Upstream compatibility facade. Shared-host activations import runtime-core instead. */
import { createToolkitRuntime } from "./runtime-core";
export * from "./runtime-core";

const upstreamRuntime = createToolkitRuntime();
export const rememberPhysicalModel = upstreamRuntime.rememberPhysicalModel;
export const registerPhysicalModelObserver = upstreamRuntime.registerPhysicalModelObserver;
export const resolveEffectiveModel = upstreamRuntime.resolveEffectiveModel;
export const resolveResponsesEnvironment = upstreamRuntime.resolveResponsesEnvironment;
export const resolveNativeCompactionEnvironment = upstreamRuntime.resolveNativeCompactionEnvironment;
export const resolveRemoteCompactionExecution = upstreamRuntime.resolveRemoteCompactionExecution;
export const getNativeCompactionRuntime = upstreamRuntime.getNativeCompactionRuntime;
