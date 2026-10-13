import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToolkitConfig } from "./config";
import { createToolkitConfigCommandRegistrar } from "./config/notifications-core";
export { describeToolkitConfig } from "./config/notifications-core";
const upstreamRegistrar = createToolkitConfigCommandRegistrar();
/** Backward-compatible global-policy command. Safe activations use the scoped registrar. */
export function registerToolkitConfigCommand(pi: ExtensionAPI, loadConfig: typeof loadToolkitConfig = loadToolkitConfig): void {
	upstreamRegistrar(pi, () => loadConfig());
}
