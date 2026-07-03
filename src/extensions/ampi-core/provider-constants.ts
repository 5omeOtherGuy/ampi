/**
 * Canonical, ampi-core-owned provider-id constants shared across extensions.
 *
 * Subscription-backed providers are auth'd via an interactive subscription/OAuth
 * session rather than an API key. The id list is the single source of truth and
 * is kept PRIVATE on purpose: it is exposed only behind the
 * {@link isMmrSubscriptionProvider} predicate so the contract is "is this a
 * subscription provider?" and no caller can mutate a shared container across an
 * extension boundary.
 *
 * This module deliberately has no runtime imports so consumers
 * (`model-resolver.ts`, `ampi-session-fallback/classifier.ts`) pull in the lone
 * predicate without dragging in transitive dependencies.
 */
const MMR_SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-subscription",
  "openai-codex",
  "github-copilot",
]);

/** True when `provider` is a subscription-backed provider id. */
export function isMmrSubscriptionProvider(provider: string): boolean {
  return MMR_SUBSCRIPTION_PROVIDERS.has(provider);
}
