import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMmrCommand } from "../ampi-core/command-registry.js";
import { getMmrModeName, listMmrModes, resolveMmrModeName } from "../ampi-core/mode-registry.js";
import { createMmrModeRouteResolver, type MmrModeRoute } from "../ampi-core/mode-routes.js";
import { MMR_MODES } from "../ampi-core/modes.js";
import { getMmrModeState, isMmrModeLocked, onMmrStateChanged } from "../ampi-core/runtime.js";
import { getMmrSpeed, MMR_TOGGLE_FAST_COMMAND_ID } from "../ampi-core/speed.js";
import type { MmrGuiBridge } from "./bridge.js";

/**
 * The mode picker's data and commands.
 *
 * `GET /api/modes` answers {@link MmrGuiModes}: the modes in the terminal
 * list's order (`low`, `medium`, `high`, `ultra`, the modes other extensions
 * registered, then `free`), each with the models it would run, and every
 * model Pi's registry has credentials for. `ampi app`'s hub answers the same
 * at its own `/api/modes` for a thread not started yet, with no current
 * mode, model, lock or speed.
 *
 * | Route        | Body                              | Effect |
 * | ------------ | --------------------------------- | ------ |
 * | `/api/mode`  | `{ mode, override? }`             | runs `/mode <key>`, as typing it does, and answers once ampi-core reports the new mode |
 * | `/api/model` | `{ provider, id, override? }`     | selects a model through `pi.setModel`; ampi-core then leaves a locked mode for `free`, as for Pi's own `/model` |
 * | `/api/fast`  | `{}`                              | runs the `speed.toggleFast` command |
 *
 * All three answer 409 while a turn runs and while another change is under
 * way. `mode` and `model` also answer 409 while the session's mode is
 * locked, unless `override` is true: the page's explicit way past the lock,
 * as `/mode` is in the terminal. A model change in `free` changes no mode,
 * and fast speed changes none either, so the lock does not apply to them.
 */

/** A model a mode would run, or one the registry lists. */
export interface MmrGuiModelRef {
  provider: string;
  id: string;
  /** The registry's display name, else the id. */
  name: string;
  /** The thinking level the mode asks for, or `null`. */
  thinkingLevel: string | null;
}

export interface MmrGuiModeRow {
  key: string;
  label: string;
  description: string;
  /** A registered mode's `#rrggbb`; `null` for the built-in modes, whose colours the page has. */
  color: string | null;
  agentModel: MmrGuiModelRef | null;
  /** `null` in `free`, which runs no subagents of ampi's. */
  oracleModel: MmrGuiModelRef | null;
  /** False when none of the mode's models is usable, so switching to it would fail. */
  available: boolean;
  reason: string | null;
}

export interface MmrGuiModes {
  /** The session's mode key (a registered mode by its key), or `null`. */
  current: string | null;
  locked: boolean;
  lockReason: string | null;
  /** The selected model as `provider/id`, or `null`. */
  model: string | null;
  /** The fast-speed row, present only while a `speed.toggleFast` command offers it. */
  fast: { on: boolean; available: boolean; reason: string | null } | null;
  modes: MmrGuiModeRow[];
  models: Array<{ provider: string; id: string; name: string }>;
}

/** The built-in modes in the picker's order, before the registered ones; `free` comes last. */
export const MMR_GUI_MODE_ORDER = ["low", "medium", "high", "ultra"] as const;

const UNAVAILABLE = "None of this mode's models is set up in Pi. Log in to a provider, or choose its models with /ampi-config.";

/** How long a mode change may take before the route answers with the mode as it is. */
export const MMR_GUI_MODE_SWITCH_TIMEOUT_MS = 5_000;

type ModesContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">;

/** The `GET /api/modes` answer; `live: false` leaves out the session's state (the hub's new-thread view). */
export function describeMmrGuiModes(ctx: ModesContext, { live = true }: { live?: boolean } = {}): MmrGuiModes {
  const routes = createMmrModeRouteResolver(ctx);
  const ref = (route: MmrModeRoute | undefined): MmrGuiModelRef | null =>
    route
      ? {
          provider: route.provider,
          id: route.model,
          name: ctx.modelRegistry.find(route.provider, route.model)?.name ?? route.model,
          thinkingLevel: route.thinkingLevel ?? null,
        }
      : null;
  const row = (key: string, label: string, description: string, color: string | null): MmrGuiModeRow => {
    const { agent, oracle } = routes(key);
    const agentModel = ref(agent);
    // `free` runs whatever Pi has selected, or nothing until a model is chosen.
    const available = key === "free" || agentModel !== null;
    return { key, label, description, color, agentModel, oracleModel: ref(oracle), available, reason: available ? null : UNAVAILABLE };
  };
  const modes = [
    ...MMR_GUI_MODE_ORDER.map((key) => row(key, MMR_MODES[key].displayName, MMR_MODES[key].description, null)),
    ...listMmrModes().map((mode) => row(mode.key, mode.label, mode.description ?? `Based on ${mode.baseMode}`, mode.color)),
    row("free", MMR_MODES.free.displayName, MMR_MODES.free.description, null),
  ];
  const models = ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name || model.id }));
  if (!live) return { current: null, locked: false, lockReason: null, model: null, fast: null, modes, models };
  const state = getMmrModeState();
  const locked = isMmrModeLocked();
  return {
    current: state ? getMmrModeName(state) : null,
    locked,
    lockReason: locked ? (state?.modeLock?.reason ?? null) : null,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    fast: fastRow(ctx as ExtensionContext),
    modes,
    models,
  };
}

function fastRow(ctx: ExtensionContext): MmrGuiModes["fast"] {
  const command = getMmrCommand(MMR_TOGGLE_FAST_COMMAND_ID);
  if (!command) return null;
  const availability = command.availability?.(ctx) ?? { state: "available" };
  if (availability.state === "hidden") return null;
  return { on: getMmrSpeed() === "fast", available: availability.state === "available", reason: availability.reason ?? null };
}

interface Result {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown> = {}): Result => ({ status: 200, body: { ok: true, ...body } });
const conflict = (error: string, extra: Record<string, unknown> = {}): Result => ({ status: 409, body: { ...extra, error } });
const invalid = (error: string): Result => ({ status: 400, body: { error } });

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export interface MmrGuiModeCommandOptions {
  /** The timer of the wait for a mode change; default `setTimeout`, unref'd. */
  setTimer?: (callback: () => unknown, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The `mode`, `model` and `fast` POST handlers of a session server (see the table above). */
export function createMmrGuiModeCommands(
  pi: Pick<ExtensionAPI, "sendUserMessage" | "setModel" | "events">,
  bridge: Pick<MmrGuiBridge, "context" | "status">,
  options: MmrGuiModeCommandOptions = {},
): Record<"mode" | "model" | "fast", (body: unknown) => Result | Promise<Result>> {
  const setTimer =
    options.setTimer ??
    ((callback: () => unknown, ms: number) => {
      const handle = setTimeout(callback, ms);
      handle.unref();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  /** One change at a time: ampi-core tells its own model changes from Pi's by a flag that a second change would clear. */
  let changing = false;

  /** The reason a change cannot start now, or `undefined`; `leavesMode` is whether it changes the session's mode. */
  function refusal(ctx: ExtensionContext, override: unknown, leavesMode: boolean): Result | undefined {
    if (override !== undefined && typeof override !== "boolean") return invalid("override must be true or false.");
    if (!ctx.isIdle() || bridge.status().busy) return conflict("Pi is working on a turn. Change it when the turn ends.", { state: "busy" });
    if (changing) return conflict("Another change is still under way.", { state: "busy" });
    if (leavesMode && isMmrModeLocked() && override !== true) {
      return conflict(getMmrModeState()?.modeLock?.reason ?? "The mode is locked.", { state: "locked" });
    }
    return undefined;
  }

  /** Run `/mode <name>` and resolve once ampi-core reports that mode, or after the timeout. */
  function switchMode(name: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimer(timer);
        // ampi-core reports the mode a little before it clears its own change flag.
        setTimer(resolve, 0);
      };
      const unsubscribe = onMmrStateChanged(pi, () => {
        const state = getMmrModeState();
        if (state && getMmrModeName(state) === name) settle();
      });
      const timer = setTimer(settle, MMR_GUI_MODE_SWITCH_TIMEOUT_MS);
      pi.sendUserMessage(`/mode ${name}`, { expandPromptTemplates: true });
    });
  }

  const currentName = () => {
    const state = getMmrModeState();
    return state ? getMmrModeName(state) : null;
  };

  return {
    async mode(body) {
      const { mode, override } = record(body);
      if (typeof mode !== "string" || mode.trim() === "") return invalid("Name a mode.");
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      if (!getMmrModeState()) return conflict("Modes need the ampi-core extension.");
      const resolved = resolveMmrModeName(mode.trim());
      if (!resolved) return invalid(`There is no mode "${mode.trim()}".`);
      const name = resolved.registered?.key ?? resolved.mode;
      if (currentName() === name) return ok({ mode: name });
      const refused = refusal(ctx, override, true);
      if (refused) return refused;
      const row = describeMmrGuiModes(ctx).modes.find((candidate) => candidate.key === name);
      if (row && !row.available) return conflict(row.reason ?? UNAVAILABLE);
      changing = true;
      try {
        await switchMode(name);
      } finally {
        changing = false;
      }
      const now = currentName();
      // ampi-core said why in a notice, in the terminal or on the page.
      return now === name ? ok({ mode: now }) : conflict(`The mode is still ${now ?? "unset"}; Pi's notice says why.`, { mode: now });
    },
    async model(body) {
      const { provider, id, override } = record(body);
      if (typeof provider !== "string" || typeof id !== "string" || provider === "" || id === "") return invalid("Name the model by its provider and id.");
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      if (!ctx.modelRegistry.find(provider, id)) return invalid(`There is no model ${provider}/${id}.`);
      const model = ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === provider && candidate.id === id);
      if (!model) return conflict(`Pi has no credentials for ${provider}/${id}.`);
      const state = getMmrModeState();
      const refused = refusal(ctx, override, state !== undefined && state.mode !== "free");
      if (refused) return refused;
      changing = true;
      let selected: boolean;
      try {
        selected = await pi.setModel(model);
      } finally {
        changing = false;
      }
      if (!selected) return conflict(`Pi could not select ${provider}/${id}.`);
      return ok({ model: `${provider}/${id}`, mode: currentName() });
    },
    async fast() {
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      const command = getMmrCommand(MMR_TOGGLE_FAST_COMMAND_ID);
      if (!command) return conflict("This session has no fast speed.");
      const refused = refusal(ctx, undefined, false);
      if (refused) return refused;
      const availability = command.availability?.(ctx) ?? { state: "available" };
      if (availability.state !== "available") return conflict(availability.reason ?? "Fast speed is not available now.");
      changing = true;
      try {
        await command.run(ctx);
      } finally {
        changing = false;
      }
      return ok({ fast: getMmrSpeed() === "fast" });
    },
  };
}
