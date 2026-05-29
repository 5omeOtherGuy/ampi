import type { MmrPlannedToolMetadata } from "./types.js";

/**
 * Catalog of pi-mmr tools scoped for future extensions but not yet
 * implemented. See `MmrPlannedToolMetadata` for the entry shape and the
 * inertness contract.
 *
 * The summary field is pi-mmr-authored prose, intentionally short and
 * neutral. It exists for in-repo documentation and so the
 * negative-injection test can defensively assert that no planned summary
 * leaks into the model-facing prompt. It is not a tool description and is
 * never surfaced to the model.
 *
 * When a planned tool ships for real, delete its entry here and register
 * the live tool in the owning extension. The snapshot matrix and
 * the negative-injection invariant test will surface any drift.
 */
export const MMR_PLANNED_TOOL_CATALOG: readonly MmrPlannedToolMetadata[] = [
  {
    name: "subagents",
    owner: "mmr-subagents",
    status: "planned",
    summary:
      "Delegate a bounded sub-task to a one-shot worker subagent with its own scoped tool set and return a compact result.",
  },
  {
    name: "read_mcp_resource",
    owner: "mmr-toolbox-mcp",
    status: "planned",
    summary:
      "Read a resource from a configured Model Context Protocol server by server name and resource URI.",
  },
  {
    // Named `load_skill` rather than `skill` so it does not collide with
    // Pi's existing prose use of the noun "skill" inside the auto-emitted
    // Pi documentation block.
    name: "load_skill",
    owner: "mmr-skills",
    status: "planned",
    summary:
      "Load a specialized skill module by name, injecting its instructions and bundled resources into the current turn.",
  },
] as const;
