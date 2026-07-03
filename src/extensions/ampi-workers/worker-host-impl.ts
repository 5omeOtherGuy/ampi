/**
 * The `ampi-workers` implementation of the core worker-host seam
 * (`ampi-core/worker-host.ts`). Registered at extension activation so
 * sibling extensions (`ampi-custom-subagents`, `ampi-history`) can register
 * worker bindings, prepare runs, run workers, and reuse the default worker
 * renderers with ZERO direct `ampi-workers` imports.
 *
 * Exactly the four seam capabilities — registerWorkerBinding,
 * prepareWorkerRun, runWorker, defaultWorkerRenderers — nothing else.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  MmrPreparedWorkerRunResult,
  MmrSubagentRunner,
} from "../ampi-core/worker-contract.js";
import {
  registerMmrWorkerHost,
  type MmrPrepareWorkerRunInput,
  type MmrRegisteredWorkerBinding,
  type MmrWorkerBindingSpec,
  type MmrWorkerHost,
} from "../ampi-core/worker-host.js";
import { registerMmrBackgroundAgent } from "./worker-binding-registry.js";
import { renderMmrSubagentCall, renderMmrSubagentResult } from "./progress-rendering.js";
import { createChildCliMmrSubagentRunner } from "./runner.js";
import type { ToolHostLike } from "./worker-host.js";
import {
  createWorkerRunPreparer,
  createWorkerTool,
  resolveWorkerModelPreferencesOverride,
  type MmrWorkerRunPreparer,
  type MmrWorkerToolFactoryDeps,
} from "./worker-tool-factory.js";

interface SeamRegisteredBinding {
  binding: MmrWorkerBindingSpec<never, unknown, never>;
  prepareRun: MmrWorkerRunPreparer<unknown>;
}

/**
 * Build the worker host over the live Pi tool host. Bindings registered
 * through the seam are tracked here (keyed by tool name) so
 * `prepareWorkerRun` can resolve them for any consumption surface.
 */
export function createMmrWorkersWorkerHost(pi: ToolHostLike, defaultRunner?: MmrSubagentRunner): MmrWorkerHost {
  const seamBindings = new Map<string, SeamRegisteredBinding>();
  const sharedRunner = defaultRunner ?? createChildCliMmrSubagentRunner();

  return {
    registerWorkerBinding<TParams, TDetails, TRun = void>(
      binding: MmrWorkerBindingSpec<TParams, TDetails, TRun>,
    ): MmrRegisteredWorkerBinding<TDetails> {
      // Normalize the model-fallback knob onto the spec the factory reads:
      // the binding-level field is the seam contract knob, but the factory
      // only honors `spec.modelFallback`. Spec-level value wins when both set.
      const spec =
        binding.spec.modelFallback === undefined && binding.modelFallback !== undefined
          ? { ...binding.spec, modelFallback: binding.modelFallback }
          : binding.spec;
      const deps: MmrWorkerToolFactoryDeps = {
        pi,
        ...(binding.runner !== undefined ? { runner: binding.runner } : {}),
        ...(binding.outputByteLimit !== undefined ? { outputByteLimit: binding.outputByteLimit } : {}),
      };
      const factoryOptions = {
        effectiveRunner: binding.runner ?? sharedRunner,
        resolveModelPreferencesOverride: (cwd: string) =>
          resolveWorkerModelPreferencesOverride({ profileName: spec.profileName, cwd }),
      };
      const tool = createWorkerTool(spec, deps, factoryOptions);
      const prepareRun = createWorkerRunPreparer(spec, deps, factoryOptions);
      seamBindings.set(spec.toolName, {
        binding: binding as unknown as MmrWorkerBindingSpec<never, unknown, never>,
        prepareRun: prepareRun as MmrWorkerRunPreparer<unknown>,
      });
      if (binding.exposure.includes("background")) {
        // The background surface dispatches through the SAME preparer, so a
        // background run of a seam-registered worker shares the blocking
        // path verbatim (validation → resolution → run thunk → projection).
        registerMmrBackgroundAgent({
          agent: spec.toolName,
          profileName: spec.profileName,
          toolName: spec.toolName,
          paramsHint: binding.paramsHint,
          promptParamKey: binding.promptParamKey,
          ...(binding.descriptionParamKey !== undefined
            ? { descriptionParamKey: binding.descriptionParamKey }
            : {}),
          start: {
            parametersSchema: spec.parameters,
            workerTools: binding.boardWorkerTools ?? spec.workerToolsConstant,
            prepareRun: (_deps, params, ctx) => prepareRun(params, ctx),
          },
        });
      }
      return {
        tool,
        prepareRun: (rawParams, ctx) => prepareRun(rawParams, ctx) as MmrPreparedWorkerRunResult<TDetails>,
      };
    },

    prepareWorkerRun(input: MmrPrepareWorkerRunInput): MmrPreparedWorkerRunResult {
      const entry = seamBindings.get(input.agent);
      if (!entry) {
        throw new Error(
          `prepareWorkerRun: no worker binding named "${input.agent}" is registered through the worker-host seam.`,
        );
      }
      // Fail closed on exposure: a run mode may only consume a binding whose
      // declared exposure allows that surface (blocking→tool,
      // background→background, internal→internal).
      const requiredExposure = input.runMode === "background"
        ? "background"
        : input.runMode === "internal"
          ? "internal"
          : "tool";
      if (!entry.binding.exposure.includes(requiredExposure)) {
        throw new Error(
          `prepareWorkerRun: binding "${input.agent}" does not expose the "${requiredExposure}" surface.`,
        );
      }
      const prep = entry.prepareRun(input.rawParams, input.ctx as ExtensionContext);
      if (prep.ok && input.runMode !== undefined) prep.prepared.runMode = input.runMode;
      return prep;
    },

    runWorker: (options) => sharedRunner.run(options),

    defaultWorkerRenderers: {
      renderCall: (toolName, args, theme, context) =>
        renderMmrSubagentCall(
          toolName,
          args,
          theme as Parameters<typeof renderMmrSubagentCall>[2],
          context as Parameters<typeof renderMmrSubagentCall>[3],
        ),
      renderResult: (toolName, result, options, theme, context) =>
        renderMmrSubagentResult(
          toolName,
          result as Parameters<typeof renderMmrSubagentResult>[1],
          options as Parameters<typeof renderMmrSubagentResult>[2],
          theme as Parameters<typeof renderMmrSubagentResult>[3],
          context as Parameters<typeof renderMmrSubagentResult>[4],
        ),
    },
  };
}

/** Self-register THE process-wide worker host (idempotent, replace-by-id). */
export function registerMmrWorkersWorkerHost(pi: ToolHostLike, defaultRunner?: MmrSubagentRunner): void {
  registerMmrWorkerHost("ampi-workers", createMmrWorkersWorkerHost(pi, defaultRunner));
}
