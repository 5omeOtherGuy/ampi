import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAmpiOwnedExtensionPath, registerAmpiOwnedTool } from "../ampi-core/owned-tools.js";

// Pi stamps each tool with the path of the extension entrypoint that
// registered it; recording ours lets Free mode recognise `painter` by source
// as well as by name.
registerAmpiOwnedExtensionPath(fileURLToPath(import.meta.url));
import { notifyMmrToolRulesChanged, registerMmrFeatureGateProvider, registerMmrToolProvider } from "../ampi-core/runtime.js";
import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../ampi-core/types.js";
import { loadMmrPainterSettings, type MmrPainterSettings } from "./config.js";
import { createMmrPainterStore, type MmrPainterStoreOptions } from "./files.js";
import {
  MMR_PAINTER_UNCHECKED,
  type MmrPainterModelChoice,
  type MmrPainterModelRegistry,
  sameMmrPainterChoice,
  selectMmrPainterModel,
} from "./model.js";
import { createMmrPainterTool, MMR_PAINTER_TOOL_NAME } from "./tool.js";

export {
  loadMmrPainterSettings,
  MMR_PAINTER_DEFAULTS,
  type MmrPainterModelRef,
  type MmrPainterSettings,
  parseMmrPainterModelRef,
} from "./config.js";
export {
  MMR_PAINTER_MAX_REFERENCE_BYTES,
  MMR_PAINTER_MAX_REFERENCES,
  type MmrPainterStoreOptions,
  resolveDefaultMmrPainterDataDir,
} from "./files.js";
export { type MmrPainterModelChoice, type MmrPainterModelRegistry, selectMmrPainterModel } from "./model.js";
export {
  buildMmrPainterPromptText,
  MMR_PAINTER_TOOL_NAME,
  PAINTER_BACKGROUND_SENTENCES,
  PAINTER_DESCRIPTION,
  PAINTER_PARAMS,
  PAINTER_PROMPT_GUIDELINES,
  PAINTER_PROMPT_SNIPPET,
} from "./tool.js";

const PAINTER_PROVIDER_NAME = "ampi-painter";
export const AMPI_PAINTER_FEATURE_GATE = "ampi-painter";
/** Legacy gate id the provider also answers for. */
export const MMR_PAINTER_FEATURE_GATE = "mmr-painter";
const PAINTER_GATES: ReadonlySet<string> = new Set([AMPI_PAINTER_FEATURE_GATE, MMR_PAINTER_FEATURE_GATE]);

export const MMR_PAINTER_DISABLED_REASON =
  "ampi-painter is off (set ampiPainter.enabled: true or AMPI_PAINTER_ENABLE=1, then restart Pi)";

export interface MmrPainterFactoryOverrides {
  loadSettings?: () => MmrPainterSettings;
  /** Pi's model registry; default `ctx.modelRegistry`. */
  modelRegistry?: (ctx: ExtensionContext) => MmrPainterModelRegistry;
  /** Where images without `output_path` go, the clock and the temp-file suffix. */
  store?: MmrPainterStoreOptions;
}

function createPainterFeatureGateProvider(enabled: boolean, choice: () => MmrPainterModelChoice): MmrFeatureGateProvider {
  return {
    name: PAINTER_PROVIDER_NAME,
    evaluate(gate) {
      if (!PAINTER_GATES.has(gate)) return undefined;
      if (!enabled) return { gate, status: "disabled", reason: MMR_PAINTER_DISABLED_REASON };
      return { gate, status: "enabled", reason: choice().reason };
    },
  };
}

/** Claims exactly `painter`: gated while the extension is off or no image model is usable. */
function createPainterToolProvider(enabled: boolean, choice: () => MmrPainterModelChoice): MmrToolProvider {
  return {
    name: PAINTER_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (toolName !== MMR_PAINTER_TOOL_NAME) return undefined;
      if (!enabled) return { kind: "gated", gate: AMPI_PAINTER_FEATURE_GATE, reason: MMR_PAINTER_DISABLED_REASON };
      const current = choice();
      return current.model ? { kind: "active" } : { kind: "gated", gate: AMPI_PAINTER_FEATURE_GATE, reason: current.reason };
    },
  };
}

export function createMmrPainterExtension(overrides: MmrPainterFactoryOverrides = {}) {
  return function ampiPainterExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrPainterSettings(process.cwd());
    let choice: MmrPainterModelChoice = MMR_PAINTER_UNCHECKED;
    registerMmrFeatureGateProvider(createPainterFeatureGateProvider(settings.enabled, () => choice));
    registerMmrToolProvider(createPainterToolProvider(settings.enabled, () => choice));
    if (!settings.enabled) return;

    const registry = overrides.modelRegistry ?? ((ctx: ExtensionContext): MmrPainterModelRegistry => ctx.modelRegistry);
    // Only the latest check may write its answer, when two overlap.
    let latestCheck = 0;
    // After session_shutdown Pi may have replaced or reloaded the session, which makes `pi` stale.
    let shutDown = false;
    const chooseModel = async (ctx: ExtensionContext): Promise<MmrPainterModelChoice> => {
      const check = ++latestCheck;
      const next = await selectMmrPainterModel(registry(ctx), settings);
      if (check === latestCheck && !sameMmrPainterChoice(choice, next)) {
        choice = next;
        // ampi-core resolved the mode's tools before this answer existed.
        if (!shutDown) {
          try {
            notifyMmrToolRulesChanged(pi);
          } catch {
            // A stale extension API throws; the next session checks again.
          }
        }
      }
      return next;
    };

    registerAmpiOwnedTool(MMR_PAINTER_TOOL_NAME);
    pi.registerTool(createMmrPainterTool({ registry, chooseModel, store: createMmrPainterStore(overrides.store) }));

    // Pi has no event for a new provider or a finished login: a new session
    // or a model switch is when painter looks again.
    pi.on("session_start", async (_event, ctx) => {
      shutDown = false;
      await chooseModel(ctx);
    });
    pi.on("session_shutdown", () => {
      shutDown = true;
    });
    pi.on("model_select", async (_event, ctx) => {
      await chooseModel(ctx);
    });
  };
}

export const createAmpiPainterExtension = createMmrPainterExtension;

const ampiPainterExtension = createMmrPainterExtension();

export default ampiPainterExtension;
