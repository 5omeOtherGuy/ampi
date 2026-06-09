import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Context handed to a `/mmr-config` section handler. Kept intentionally small;
 * extend only with cross-cutting inputs the core menu can always supply.
 */
export interface MmrConfigFlowSectionContext {
  /** Registered Pi tool names, forwarded to setup/import wizards. */
  getAvailableTools?(): readonly string[];
}

/**
 * A sibling-owned section of the `/mmr-config` menu. Extensions register their
 * own config sub-flows here instead of `mmr-core` importing them, inverting the
 * former `mmr-core` -> sibling dependency (see `MMR_CORE_SIBLING_IMPORT_EXCEPTIONS`).
 */
export interface MmrConfigFlowSection {
  /** Stable id; re-registration with the same id replaces the prior entry. */
  readonly id: string;
  /** Menu label shown in the `/mmr-config` picker. */
  readonly label: string;
  /** Lower sorts earlier; ties broken by label for determinism. */
  readonly order: number;
  /** Invoked when the user selects this section's label. */
  run(ctx: ExtensionContext, sectionCtx: MmrConfigFlowSectionContext): Promise<void> | void;
}

// globalThis-anchored so registration survives cache-isolated module loads
// (parent and child Pi processes can each load these modules under distinct
// module identities; the registry must be process-global, not module-local).
const MMR_CONFIG_FLOW_SECTIONS_GLOBAL_KEY = "__pi_mmr_config_flow_sections_v1__";
const globalStore = globalThis as typeof globalThis & {
  [MMR_CONFIG_FLOW_SECTIONS_GLOBAL_KEY]?: Map<string, MmrConfigFlowSection>;
};
const sections: Map<string, MmrConfigFlowSection> = (globalStore[MMR_CONFIG_FLOW_SECTIONS_GLOBAL_KEY] ??= new Map<
  string,
  MmrConfigFlowSection
>());

/**
 * Register (or replace, by `id`) a `/mmr-config` section. Idempotent: safe to
 * call once at extension module load. No-ops on an empty id or label.
 */
export function registerMmrConfigFlowSection(section: MmrConfigFlowSection): void {
  const id = section.id.trim();
  const label = section.label.trim();
  if (id.length === 0 || label.length === 0) return;
  sections.set(id, { ...section, id, label });
}

/**
 * The registered sections in stable display order (by `order`, then `label`).
 */
export function listMmrConfigFlowSections(): readonly MmrConfigFlowSection[] {
  return [...sections.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** Test-only: clear the registry. Production code must not call this. */
export function __resetMmrConfigFlowSectionsForTests(): void {
  sections.clear();
}
