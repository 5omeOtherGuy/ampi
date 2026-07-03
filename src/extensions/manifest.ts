/**
 * Capability manifest for every `ampi` extension directory.
 *
 * This module is the single declarative source of truth that the architecture
 * guardrail tests (`tests/mmr-architecture-manifest.test.mjs`) cross-check
 * against the real wiring:
 *
 *   - `package.json` `pi.extensions` (which entrypoints auto-load),
 *   - `package.json` `exports` (public subpath surface),
 *   - the on-disk `src/extensions/*` directory set,
 *   - the subagent child keep-set (`MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS`),
 *   - the planned-tool catalog (`MMR_PLANNED_TOOL_CATALOG`),
 *   - the `ampi-core` -> sibling import direction.
 *
 * It is intentionally dependency-free pure data so it can be imported in
 * isolation. As the greenfield extension split proceeds, each chunk updates the
 * manifest in lockstep with the code it moves, and the guardrail tests fail if
 * the manifest and the real wiring drift apart.
 *
 * Scope note: fields here describe statically-knowable ownership (entrypoint,
 * public export, owned tool names, feature gates, risk/child role). Runtime
 * commands, persisted state keys, and env gates are not yet enumerated; they are
 * added per-chunk as the owning code moves, so the manifest never asserts data
 * it cannot back.
 */

/** Coarse risk class, used for review and diagnostics, not enforcement. */
export type MmrExtensionRiskClass =
  | "substrate" // mode/policy/prompt substrate; no external side effects
  | "passive" // hook-only; observes/falls back, registers no model tool
  | "local-mutation" // mutates the local workspace or local session state
  | "network" // performs outbound network requests
  | "remote-repo" // reads remote repository data
  | "session-data" // reads local session/history data
  | "subprocess" // spawns child agent processes
  | "diagnostic"; // debug capture / inspection

/**
 * Role this extension plays in subagent child-process scoping.
 *  - substrate    : always kept (owns the `--ampi-subagent` activation guard).
 *  - worker-owner : registers subagent worker tools/profiles.
 *  - worker-dep   : owns tools a worker keep-set depends on.
 *  - none         : not part of any child keep-set.
 */
export type MmrExtensionChildRole = "substrate" | "worker-owner" | "worker-dep" | "none";

export interface MmrExtensionManifestEntry {
  /** Directory name under `src/extensions`, the canonical extension id. */
  readonly name: string;
  /** Entrypoint path relative to the package root (matches `pi.extensions` when auto-loaded). */
  readonly entrypoint: string;
  /** `package.json` `exports` subpath, or `null` when not publicly exported. */
  readonly exportSubpath: string | null;
  /** Additional public subpaths that intentionally alias the same entrypoint. */
  readonly exportAliases?: readonly string[];
  /** Whether the entrypoint is registered in `package.json` `pi.extensions`. */
  readonly autoLoaded: boolean;
  /** Concrete, statically-known Pi tool names this extension owns. */
  readonly tools: readonly string[];
  /** Whether this extension also registers dynamic (runtime-named) tools. */
  readonly dynamicTools: boolean;
  /** Feature-gate ids owned by this extension. */
  readonly featureGates: readonly string[];
  readonly riskClass: MmrExtensionRiskClass;
  readonly childRole: MmrExtensionChildRole;
}

/**
 * Current canonical manifest. Compatibility aliases remain listed only where
 * external callers can still import or query the old `mmr-*` identifiers.
 */
export const MMR_EXTENSION_MANIFEST: readonly MmrExtensionManifestEntry[] = Object.freeze([
  {
    name: "ampi-core",
    entrypoint: "./src/extensions/ampi-core/index.ts",
    exportSubpath: "./extensions/ampi-core",
    exportAliases: ["./extensions/mmr-core"],
    autoLoaded: true,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "substrate",
    childRole: "substrate",
  },
  {
    name: "ampi-session-fallback",
    entrypoint: "./src/extensions/ampi-session-fallback/index.ts",
    exportSubpath: "./extensions/ampi-session-fallback",
    exportAliases: ["./extensions/mmr-session-fallback"],
    autoLoaded: true,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "passive",
    childRole: "none",
  },
  {
    name: "ampi-patch",
    entrypoint: "./src/extensions/ampi-patch/index.ts",
    exportSubpath: "./extensions/ampi-patch",
    exportAliases: ["./extensions/mmr-patch"],
    autoLoaded: true,
    tools: ["apply_patch"],
    dynamicTools: false,
    featureGates: [],
    riskClass: "local-mutation",
    childRole: "none",
  },
  {
    name: "ampi-tasks",
    entrypoint: "./src/extensions/ampi-tasks/index.ts",
    exportSubpath: "./extensions/ampi-tasks",
    exportAliases: ["./extensions/mmr-tasks"],
    autoLoaded: true,
    tools: ["task_list"],
    dynamicTools: false,
    featureGates: [],
    riskClass: "local-mutation",
    childRole: "worker-dep",
  },
  {
    // Deprecated compatibility shim: split into ampi-patch + ampi-tasks. Not
    // auto-loaded; re-exports the former `./extensions/mmr-toolbox` surface.
    name: "ampi-toolbox",
    entrypoint: "./src/extensions/ampi-toolbox/index.ts",
    exportSubpath: "./extensions/ampi-toolbox",
    exportAliases: ["./extensions/mmr-toolbox"],
    autoLoaded: false,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "local-mutation",
    childRole: "none",
  },
  {
    name: "ampi-web",
    entrypoint: "./src/extensions/ampi-web/index.ts",
    exportSubpath: "./extensions/ampi-web",
    exportAliases: ["./extensions/mmr-web"],
    autoLoaded: true,
    tools: ["web_search", "read_web_page"],
    dynamicTools: false,
    featureGates: ["ampi-web", "mmr-web"],
    riskClass: "network",
    childRole: "worker-dep",
  },
  {
    name: "ampi-github",
    entrypoint: "./src/extensions/ampi-github/index.ts",
    exportSubpath: "./extensions/ampi-github",
    exportAliases: ["./extensions/mmr-github"],
    autoLoaded: true,
    tools: [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ],
    dynamicTools: false,
    featureGates: ["ampi-github", "mmr-github"],
    riskClass: "remote-repo",
    childRole: "worker-dep",
  },
  {
    name: "ampi-workers",
    entrypoint: "./src/extensions/ampi-workers/index.ts",
    exportSubpath: "./extensions/ampi-workers",
    exportAliases: ["./extensions/mmr-workers"],
    autoLoaded: true,
    tools: [
      "finder",
      "oracle",
      "librarian",
      "reviewer",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
    ],
    dynamicTools: false,
    // One unified gate; the pre-merge ids stay accepted aliases.
    featureGates: [
      "ampi-workers",
      "ampi-subagents",
      "ampi-async-tasks",
      "ampi-subagents.async-tasks",
      "mmr-workers",
      "mmr-subagents",
      "mmr-async-tasks",
      "mmr-subagents.async-tasks",
    ],
    riskClass: "subprocess",
    childRole: "worker-owner",
  },
  {
    name: "ampi-custom-subagents",
    entrypoint: "./src/extensions/ampi-custom-subagents/index.ts",
    exportSubpath: "./extensions/ampi-custom-subagents",
    exportAliases: ["./extensions/mmr-custom-subagents"],
    autoLoaded: true,
    tools: [],
    dynamicTools: true,
    featureGates: ["ampi-custom-subagents", "mmr-custom-subagents"],
    riskClass: "subprocess",
    childRole: "worker-owner",
  },
  {
    name: "ampi-history",
    entrypoint: "./src/extensions/ampi-history/index.ts",
    exportSubpath: "./extensions/ampi-history",
    exportAliases: ["./extensions/mmr-history"],
    autoLoaded: true,
    tools: ["read_session", "find_session"],
    dynamicTools: false,
    featureGates: ["ampi-history", "mmr-history"],
    riskClass: "session-data",
    childRole: "worker-dep",
  },
  {
    name: "ampi-debug",
    entrypoint: "./src/extensions/ampi-debug/index.ts",
    exportSubpath: null,
    autoLoaded: false,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "diagnostic",
    childRole: "none",
  },
]);

/**
 * Known `ampi-core` -> sibling-extension imports that currently violate the
 * "core depends on no sibling" invariant. The dependency-direction guardrail
 * asserts core imports no sibling OUTSIDE this set, so new couplings fail while
 * these documented ones are driven to zero by later chunks:
 *
 * The set is now empty: `ampi-core` imports no sibling extension. Sibling
 * extensions invert the former couplings by registering into core-owned
 * registries instead:
 *  - `/ampi-config` and `/ampi-config` sections ->
 *    `registerMmrConfigFlowSection` (was direct imports of web/custom-subagent
 *    config flows).
 *  - subagent owned-tool gates -> `registerMmrOwnedToolSourcePath` +
 *    profile `requiredOwnedTools` (was a direct import of GitHub ownership).
 *
 * Keep it empty: the architecture guardrail test fails if any `ampi-core`
 * module imports a sibling extension that is not listed here.
 */
export const MMR_CORE_SIBLING_IMPORT_EXCEPTIONS: readonly string[] = Object.freeze([]);

/** Convenience: the set of canonical extension directory names. */
export function getMmrExtensionNames(): readonly string[] {
  return MMR_EXTENSION_MANIFEST.map((entry) => entry.name);
}

/** Lookup a manifest entry by canonical extension name. */
export function getMmrExtensionManifestEntry(name: string): MmrExtensionManifestEntry | undefined {
  return MMR_EXTENSION_MANIFEST.find((entry) => entry.name === name);
}
