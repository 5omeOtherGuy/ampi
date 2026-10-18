import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MmrCommandAvailability, type MmrCommandDefinition, registerMmrCommand } from "./command-registry.js";
import { isRecord } from "./internal/json.js";
import { isOpenAiResponsesShape } from "./request-policy.js";
import { getMmrModeState, getMmrSubagentState, MMR_EVENT_STATE_CHANGED } from "./runtime.js";

/**
 * Fast speed: the session asks the provider for priority serving, which
 * answers sooner and costs more. ampi-core keeps one speed per session,
 * stores each change as an `ampi-speed` session entry (never sent to the
 * model) and writes the provider's priority tier into the request in
 * `before_provider_request`. Subagent workers always run at standard speed.
 */

export type MmrSpeed = "standard" | "fast";

/** Custom session entry type that records a speed change. */
export const MMR_SPEED_ENTRY_TYPE = "ampi-speed";
/** Pi flag that starts a new session at fast speed. */
export const MMR_FAST_FLAG = "ampi-fast";
/** Palette command that turns fast speed on or off. */
export const MMR_TOGGLE_FAST_COMMAND_ID = "speed.toggleFast";
/** Marker drawn before the mode name while fast speed is in effect. */
export const MMR_FAST_MARKER = "↯";

export type MmrFastSupport =
  | { readonly supported: true; readonly serviceTier: "priority"; readonly costMultiple: number }
  | { readonly supported: false; readonly reason: string };

/**
 * Providers whose OpenAI Responses requests accept `service_tier: "priority"`.
 * The cost multiples follow the priority pricing in `@earendil-works/pi-ai`
 * (2x, 2.5x for `gpt-5.5`), so Pi's cost reports and ampi's agree; move them
 * together when Pi changes its pricing.
 */
const PRIORITY_TIER_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex"]);
const PRIORITY_COST_MULTIPLE = 2;
const PRIORITY_COST_MULTIPLE_BY_MODEL: Readonly<Record<string, number>> = { "gpt-5.5": 2.5 };

/** Whether fast speed can be requested from `providerId`, at what cost multiple, or why not. */
export function getMmrFastSupport(providerId: string | undefined, modelId?: string): MmrFastSupport {
  if (!providerId) return { supported: false, reason: "no model is selected" };
  if (!PRIORITY_TIER_PROVIDERS.has(providerId)) {
    return { supported: false, reason: `${providerId} offers no priority tier ampi can request` };
  }
  const costMultiple =
    modelId !== undefined && Object.hasOwn(PRIORITY_COST_MULTIPLE_BY_MODEL, modelId)
      ? PRIORITY_COST_MULTIPLE_BY_MODEL[modelId]
      : PRIORITY_COST_MULTIPLE;
  return { supported: true, serviceTier: "priority", costMultiple };
}

/**
 * Write the priority tier into a provider-bound payload. Pure: for `fast` on a
 * supported provider and an OpenAI Responses-shaped payload (the Codex
 * variant included) it returns a shallow copy with `service_tier:
 * "priority"`; otherwise the payload itself. Standard speed never writes
 * `service_tier`, so a tier configured for the provider is left as it is.
 */
export function applyMmrSpeedToPayload(payload: unknown, speed: MmrSpeed, options: { providerId?: string } = {}): unknown {
  if (speed !== "fast") return payload;
  const support = getMmrFastSupport(options.providerId);
  if (!support.supported || !isOpenAiResponsesShape(payload)) return payload;
  return { ...payload, service_tier: support.serviceTier };
}

function isMmrSpeed(value: unknown): value is MmrSpeed {
  return value === "standard" || value === "fast";
}

/** The speed of the newest valid `ampi-speed` entry in `entries`, or `undefined` when there is none. */
export function findLatestMmrSpeed(entries: readonly unknown[]): MmrSpeed | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== MMR_SPEED_ENTRY_TYPE) continue;
    const speed = isRecord(entry.data) ? entry.data.speed : undefined;
    if (isMmrSpeed(speed)) return speed;
  }
  return undefined;
}

/** A session's speed: its newest `ampi-speed` entry; for a session without one, fast with the flag, else the setting, else standard. */
export function resolveMmrSessionSpeed(input: { entries: readonly unknown[]; flag?: boolean; setting?: MmrSpeed }): MmrSpeed {
  return findLatestMmrSpeed(input.entries) ?? (input.flag ? "fast" : (input.setting ?? "standard"));
}

function formatCostMultiple(multiple: number): string {
  return `${multiple}x`;
}

/** The `/ampi-status` value: `standard`, `fast (priority tier, about 2x the price)` or `fast (not available for <provider>)`. */
export function formatMmrSpeedStatus(speed: MmrSpeed, providerId: string | undefined, modelId?: string): string {
  if (speed === "standard") return "standard";
  const support = getMmrFastSupport(providerId, modelId);
  if (support.supported) return `fast (priority tier, about ${formatCostMultiple(support.costMultiple)} the price)`;
  return providerId ? `fast (not available for ${providerId})` : `fast (not available: ${support.reason})`;
}

// globalThis-anchored so ampi-tui, loaded as a separate extension entry,
// reads the speed core set.
const SPEED_GLOBAL_KEY = "__pi_ampi_speed_v1__";
const globalStore = globalThis as typeof globalThis & { [SPEED_GLOBAL_KEY]?: { speed: MmrSpeed } };
const store = globalStore[SPEED_GLOBAL_KEY] ?? { speed: "standard" };
globalStore[SPEED_GLOBAL_KEY] = store;

/** The current session's speed. Always `standard` in a subagent worker. */
export function getMmrSpeed(): MmrSpeed {
  return getMmrSubagentState() ? "standard" : store.speed;
}

export function setMmrSpeed(speed: MmrSpeed): void {
  store.speed = speed;
}

interface MmrModelRef {
  readonly provider: string;
  readonly id: string;
}

/** Whether requests to `model` go out at fast speed now: fast is on and its provider has a priority tier. */
export function isMmrFastInEffect(model: MmrModelRef | undefined): boolean {
  return getMmrSpeed() === "fast" && getMmrFastSupport(model?.provider, model?.id).supported;
}

function toggleFastVerb(model: MmrModelRef | undefined): string {
  if (getMmrSpeed() === "fast") return "disable fast";
  const support = getMmrFastSupport(model?.provider, model?.id);
  return support.supported ? `use fast (${formatCostMultiple(support.costMultiple)} cost)` : "use fast";
}

function toggleFastAvailability(ctx: ExtensionContext): MmrCommandAvailability {
  if (getMmrSubagentState()) return { state: "hidden" };
  // Turning fast off always works, whatever the provider is now.
  if (getMmrSpeed() === "fast") return { state: "available" };
  const support = getMmrFastSupport(ctx.model?.provider, ctx.model?.id);
  return support.supported ? { state: "available" } : { state: "unavailable", reason: support.reason };
}

/** The `speed.toggleFast` palette command, its verb naming the current speed and `model`'s cost multiple. */
export function createMmrToggleFastCommand(pi: Pick<ExtensionAPI, "appendEntry" | "events">, model: MmrModelRef | undefined): MmrCommandDefinition {
  return {
    id: MMR_TOGGLE_FAST_COMMAND_ID,
    noun: "speed",
    verb: toggleFastVerb(model),
    description: "Turn fast speed on or off: priority serving from the provider, at a higher price",
    defaultKey: "alt+r",
    keywords: ["fast", "priority", "speed"],
    availability: toggleFastAvailability,
    run: (ctx) => toggleMmrFastSpeed(pi, ctx),
  };
}

/** Register `speed.toggleFast` in the command registry, or replace it so its verb follows the speed and `model`. */
export function registerMmrToggleFastCommand(pi: Pick<ExtensionAPI, "appendEntry" | "events">, model: MmrModelRef | undefined): void {
  registerMmrCommand(createMmrToggleFastCommand(pi, model));
}

/** Set the speed, refresh the command and tell core's state listeners; nothing happens when it is unchanged. */
export function changeMmrSpeed(pi: Pick<ExtensionAPI, "appendEntry" | "events">, speed: MmrSpeed, model: MmrModelRef | undefined): void {
  const changed = store.speed !== speed;
  setMmrSpeed(speed);
  registerMmrToggleFastCommand(pi, model);
  if (changed) pi.events.emit(MMR_EVENT_STATE_CHANGED, getMmrModeState());
}

/** Say why fast speed cannot be turned on now. False, saying nothing, when it can be toggled. */
export function explainMmrFastUnavailable(ctx: ExtensionContext): boolean {
  const availability = toggleFastAvailability(ctx);
  if (availability.state === "available") return false;
  if (availability.state === "unavailable") ctx.ui.notify(`Fast speed is not available: ${availability.reason}.`, "info");
  return true;
}

/**
 * Turn fast speed on or off for this session, record the change as a session
 * entry and say what it costs. Turning it on where the provider has no
 * priority tier only says why.
 */
export function toggleMmrFastSpeed(pi: Pick<ExtensionAPI, "appendEntry" | "events">, ctx: ExtensionContext): void {
  if (explainMmrFastUnavailable(ctx)) return;
  const next: MmrSpeed = getMmrSpeed() === "fast" ? "standard" : "fast";
  changeMmrSpeed(pi, next, ctx.model);
  pi.appendEntry(MMR_SPEED_ENTRY_TYPE, { speed: next });
  const mode = getMmrModeState()?.mode;
  const scope = mode ? ` for ${mode}` : "";
  if (next === "standard") {
    ctx.ui.notify(`Fast speed off${scope}: standard serving at the standard price.`, "info");
    return;
  }
  const support = getMmrFastSupport(ctx.model?.provider, ctx.model?.id);
  const multiple = support.supported ? support.costMultiple : PRIORITY_COST_MULTIPLE;
  ctx.ui.notify(`Fast speed on${scope}: priority serving at about ${formatCostMultiple(multiple)} the price.`, "info");
}
