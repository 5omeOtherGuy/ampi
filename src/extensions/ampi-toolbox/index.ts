/**
 * @deprecated `ampi-toolbox` has been split into two extensions:
 *   - `ampi-patch` owns `apply_patch`
 *   - `ampi-tasks` owns `task_list`
 *
 * This module is a compatibility shim that re-exports the former public
 * `./extensions/ampi-toolbox` surface from the new owners. It is no longer
 * registered in `package.json` `pi.extensions` and registers no tools itself;
 * the `ampi-patch` and `ampi-tasks` entrypoints do that. Import from
 * `@earendil-works/ampi/extensions/ampi-patch` and `.../extensions/ampi-tasks`
 * (or the package root barrel) instead.
 */
import type { MmrToolProvider } from "../ampi-core/types.js";
import { registerMmrPatchProviders } from "../ampi-patch/index.js";
import { registerMmrTasksProviders } from "../ampi-tasks/index.js";

export {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_PARAMS,
  APPLY_PATCH_PROMPT_GUIDELINES,
  APPLY_PATCH_PROMPT_SNIPPET,
  unifiedDiffToEditRenderableDiff,
} from "../ampi-patch/apply-patch-tool.js";

/**
 * @deprecated Use `registerAmpiPatchProviders` and `registerAmpiTasksProviders`
 * from `ampi-patch` / `ampi-tasks`. Retained so existing callers keep claiming
 * ownership of both former toolbox tools on a registry.
 */
export function registerMmrToolboxProviders(registry: {
  registerProvider(provider: MmrToolProvider): void;
}): void {
  registerMmrPatchProviders(registry);
  registerMmrTasksProviders(registry);
}

export const registerAmpiToolboxProviders = registerMmrToolboxProviders;
