/** Upstream compatibility notifier; safe activations own their own notice cache. */
import { createConfigNotifier } from "./notifications-core";
export { formatConfigIssues } from "./notifications-core";
const upstreamNotifier = createConfigNotifier();
export const notifyConfigIssues = upstreamNotifier.notifyConfigIssues;
