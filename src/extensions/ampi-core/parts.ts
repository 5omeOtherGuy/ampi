/**
 * Which ampi parts (extensions) this process loaded, and the warning when
 * ampi-core is not among them.
 *
 * Users choose ampi's parts with an extension filter on the ampi entry in
 * Pi's settings (`ampi setup` writes it; `pi config` edits the same
 * entries), so any part but ampi-core may be missing. Each extension's
 * factory calls {@link markAmpiPartLoaded}; ampi-workers reads the set to
 * keep a part the user turned off out of the subagent processes it starts.
 *
 * ampi-core is first in `pi.extensions`, so its factory runs before every
 * other part's on each load and reload, and starts the set afresh. A part
 * that loads without it still works as far as it can, but without ampi's
 * modes, model routing and tool policy, so the first such part warns once
 * per load when the session starts.
 *
 * globalThis-anchored like the other core registries: Pi may load the
 * extensions with isolated module caches.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AMPI_CORE_PART = "ampi-core";

const PARTS_GLOBAL_KEY = "__pi_ampi_loaded_parts_v1__";
const CORE_WARNING_GLOBAL_KEY = "__pi_ampi_core_missing_warning_v1__";

const globalStore = globalThis as typeof globalThis & {
  [PARTS_GLOBAL_KEY]?: Set<string>;
  [CORE_WARNING_GLOBAL_KEY]?: boolean;
};

function loadedParts(): Set<string> {
  globalStore[PARTS_GLOBAL_KEY] ??= new Set<string>();
  return globalStore[PARTS_GLOBAL_KEY];
}

/**
 * The message shown when parts load without ampi-core.
 *
 * @param parts The ampi parts that loaded.
 */
export function formatAmpiCoreMissingWarning(parts: readonly string[]): string {
  return `ampi: ${parts.join(", ")} loaded without ampi-core, so ampi's modes, model routing and tool policy are off. ampi-core is required: turn it back on with "ampi setup" or in "pi config", then restart Pi.`;
}

/**
 * Record that the extension `name` (its directory name, such as `ampi-web`)
 * loaded. Call it from the extension's factory.
 */
export function markAmpiPartLoaded(pi: ExtensionAPI, name: string): void {
  const parts = loadedParts();
  if (name === AMPI_CORE_PART) {
    parts.clear();
    parts.add(name);
    return;
  }
  parts.add(name);
  if (parts.has(AMPI_CORE_PART) || globalStore[CORE_WARNING_GLOBAL_KEY]) return;
  globalStore[CORE_WARNING_GLOBAL_KEY] = true;
  pi.on("session_start", (_event, ctx) => {
    globalStore[CORE_WARNING_GLOBAL_KEY] = false;
    // Another load order (explicit -e paths) can bring ampi-core in after this part.
    if (loadedParts().has(AMPI_CORE_PART)) return;
    const message = formatAmpiCoreMissingWarning([...loadedParts()]);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  });
}

/** The ampi parts this process loaded, by extension directory name. */
export function getLoadedAmpiParts(): ReadonlySet<string> {
  return loadedParts();
}
