import type {
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateRegistry,
} from "./types.js";

/**
 * Feature-gate resolver.
 *
 * ampi-core does not implement feature behavior; it only resolves named gates so
 * that mode resolution can record an explainable decision per gate. The
 * resolver is built from an ordered list of providers: later registrations take
 * precedence and may return `enabled`, `disabled`, or `missing` decisions.
 *
 * Two providers are always present in the chain:
 *
 * - `ampi-core.reserved`: known names reserved for future ampi extensions. They
 *   resolve as `missing` with a per-gate reason that names the owning
 *   extension. This makes status output stable and lets later modules detect
 *   that ampi-core has at least heard of them.
 * - `mmr-core.unknown`: terminal fallback for any name no provider claims. It
 *   resolves as `missing` with a generic "unknown feature gate" reason so
 *   typos and stale gate names surface in `/ampi-status` instead of being
 *   silently ignored.
 *
 * Server- and package-provided gates plug in via `registerProvider(...)` on a
 * registry instance (typically the runtime singleton in runtime.ts). Providers
 * registered later take precedence; this lets later ampi extensions override a
 * reserved decision once they actually ship the feature.
 */

/**
 * Reserved gate names. The contract is: a gate name is the bare extension
 * identifier (`ampi-workers`, not `ampi-workers.enabled`). Modes opt in by
 * listing the extension name in `MmrModeDefinition.featureGates`, and the
 * reserved provider answers "missing" until that extension actually ships and
 * registers a provider that overrides the decision. Keep this map in sync with
 * the set of extensions consuming the reserved-gate convention.
 */
const RESERVED_GATE_REASONS: Record<string, string> = {
  "ampi-workers": "Reserved for the ampi-workers extension; not yet provided.",
  "ampi-subagents": "Compatibility gate for the worker surface in ampi-workers; not yet provided.",
  "ampi-async-tasks": "Compatibility gate for background task tools in ampi-workers; not yet provided.",
  "ampi-subagents.async-tasks": "Compatibility gate for background task tools in ampi-workers; not yet provided.",
  "ampi-history": "Reserved for the ampi-history extension; not yet provided.",
  "ampi-web": "Reserved for the ampi-web extension; not yet provided.",
  "ampi-github": "Reserved for the ampi-github extension; not yet provided.",
  "ampi-custom-subagents": "Reserved for the ampi-custom-subagents extension; not yet provided.",
  "ampi-patch": "Reserved for the ampi-patch extension; not yet provided.",
  "ampi-tasks": "Reserved for the ampi-tasks extension; not yet provided.",
  "ampi-toolbox-mcp": "Reserved for the ampi-toolbox-mcp extension; not yet provided.",
  "mmr-workers": "Legacy alias for the ampi-workers extension; not yet provided.",
  "mmr-subagents": "Legacy alias for the worker surface in ampi-workers; not yet provided.",
  "mmr-async-tasks": "Legacy alias for background task tools in ampi-workers; not yet provided.",
  "mmr-subagents.async-tasks": "Deprecated compatibility gate for background task tools in ampi-workers; not yet provided.",
  "mmr-history": "Legacy alias for the ampi-history extension; not yet provided.",
  "mmr-web": "Legacy alias for the ampi-web extension; not yet provided.",
  "mmr-github": "Legacy alias for the ampi-github extension; not yet provided.",
  "mmr-custom-subagents": "Legacy alias for the ampi-custom-subagents extension; not yet provided.",
  "mmr-patch": "Legacy alias for the ampi-patch extension; not yet provided.",
  "mmr-tasks": "Legacy alias for the ampi-tasks extension; not yet provided.",
  "mmr-toolbox-mcp": "Legacy alias for the ampi-toolbox-mcp extension; not yet provided.",
};

const RESERVED_PROVIDER: MmrFeatureGateProvider = {
  name: "ampi-core.reserved",
  evaluate(gate) {
    // Use Object.hasOwn to ignore prototype-chain names like "toString" or
    // "constructor", matching the same defensive lookup tool-registry.ts uses
    // for user aliases. A bracket lookup would otherwise return a `Function`
    // (truthy) and short-circuit the guard, producing a decision whose `reason`
    // violates `MmrFeatureGateDecision`.
    if (!Object.hasOwn(RESERVED_GATE_REASONS, gate)) return undefined;
    const reason = RESERVED_GATE_REASONS[gate];
    return { gate, status: "missing", reason };
  },
};

/**
 * Terminal catch-all provider. Always claims the gate as `missing` so the
 * registry never produces an unsourced decision and consumers can introspect
 * it via `getProviders()` like any other provider.
 */
const UNKNOWN_PROVIDER: MmrFeatureGateProvider = {
  name: "ampi-core.unknown",
  evaluate(gate) {
    return { gate, status: "missing", reason: "Unknown feature gate; no provider claimed it." };
  },
};

export function createMmrFeatureGateRegistry(): MmrFeatureGateRegistry {
  // Higher index = higher priority. The unknown catch-all sits at the bottom
  // so it only fires when nothing else claims the gate; reserved sits just
  // above it; explicit registrations push to the top and take precedence.
  const providers: MmrFeatureGateProvider[] = [UNKNOWN_PROVIDER, RESERVED_PROVIDER];

  function evaluateGate(gate: string): MmrFeatureGateDecision {
    for (let i = providers.length - 1; i >= 0; i -= 1) {
      const provider = providers[i];
      const decision = provider.evaluate(gate);
      if (decision) return { ...decision, source: provider.name };
    }
    // Unreachable: UNKNOWN_PROVIDER always returns a decision.
    throw new Error(`No provider resolved feature gate "${gate}"`);
  }

  return {
    registerProvider(provider) {
      providers.push(provider);
    },
    resolve(gates) {
      return gates.map(evaluateGate);
    },
    getProviders() {
      return [...providers];
    },
  };
}

/**
 * Module-level resolver used by callers that do not need a long-lived registry
 * (tests, ad-hoc decisions). It always uses a fresh registry containing only
 * the built-in reserved/unknown providers, so registrations on the runtime
 * singleton never leak into module-level calls and vice versa.
 */
export function resolveMmrFeatureGates(gates: readonly string[]): MmrFeatureGateDecision[] {
  return createMmrFeatureGateRegistry().resolve(gates);
}
