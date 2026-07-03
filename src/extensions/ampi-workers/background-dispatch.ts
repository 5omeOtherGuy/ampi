/**
 * Background-dispatch seam between the named worker tools and the background
 * task surface.
 *
 * The v2 worker surface lets `finder`, `librarian`, and `Task` take
 * `background?: true` (plus `group?`/`notify?`) directly. The worker-tool
 * factory owns the blocking path; when a call asks for a background run it
 * delegates here. `registerAsyncTaskTools` installs the dispatcher (and the
 * live-card extras the renderer needs) when the background surface
 * registers, so the named tools fail closed with a clear message when the
 * background surface is not available.
 */
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BackgroundCardExtras } from "./progress-rendering.js";

/**
 * The shared v2 background fields every backgroundable worker tool's schema
 * spreads in (finder, librarian, Task — not oracle, which is blocking-only).
 * One definition so the model-visible wording never drifts between tools.
 */
export const MMR_BACKGROUND_RUN_PARAMETER_FIELDS = {
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run this worker as a background task: returns an opaque task_id immediately instead of blocking, so you can keep working while it runs. The result arrives via automatic completion delivery, or explicitly via task_poll/task_wait.",
    }),
  ),
  group: Type.Optional(
    Type.String({
      maxLength: 256,
      description:
        "Optional worker-group key for background runs. Parallel background calls that share the same group key land in one worker group (one card, one settle, one grouped notification). Requires background: true.",
    }),
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        "Automatic completion delivery for a background run (on by default). Pass false to opt out and retrieve the result explicitly with task_poll/task_wait. Requires background: true.",
    }),
  ),
} as const;

export interface MmrBackgroundDispatchInput {
  /** Public background-agent name; equals the calling worker tool's name. */
  agent: string;
  /** The worker's own params with the v2 fields already stripped. */
  params: Record<string, unknown>;
  /**
   * Caller-chosen group key: parallel background calls sharing the same key
   * land in one worker group (rendered and settled together).
   */
  group?: string | undefined;
  /** Automatic completion delivery opt-out (default on). */
  notify?: boolean | undefined;
  toolCallId: string;
  ctx: ExtensionContext;
}

export type MmrBackgroundDispatcher = (
  input: MmrBackgroundDispatchInput,
) => Promise<AgentToolResult<unknown>>;

// Stored on globalThis (mirroring the dynamic profile/agent registries) so
// duplicate module instantiations in one process share one seam.
const AMPI_BACKGROUND_DISPATCH_GLOBAL_KEY = "__pi_ampi_background_dispatch_v1__";
const MMR_BACKGROUND_DISPATCH_GLOBAL_KEY = "__pi_mmr_background_dispatch_v1__";

interface BackgroundDispatchStore {
  dispatcher?: MmrBackgroundDispatcher | undefined;
  cardExtras?: BackgroundCardExtras | undefined;
}

const globalDispatchStore = globalThis as typeof globalThis & {
  [AMPI_BACKGROUND_DISPATCH_GLOBAL_KEY]?: BackgroundDispatchStore;
  [MMR_BACKGROUND_DISPATCH_GLOBAL_KEY]?: BackgroundDispatchStore;
};

function resolveDispatchStore(): BackgroundDispatchStore {
  const existing = globalDispatchStore[AMPI_BACKGROUND_DISPATCH_GLOBAL_KEY]
    ?? globalDispatchStore[MMR_BACKGROUND_DISPATCH_GLOBAL_KEY];
  if (existing) {
    globalDispatchStore[AMPI_BACKGROUND_DISPATCH_GLOBAL_KEY] = existing;
    globalDispatchStore[MMR_BACKGROUND_DISPATCH_GLOBAL_KEY] = existing;
    return existing;
  }
  const fresh: BackgroundDispatchStore = {};
  globalDispatchStore[AMPI_BACKGROUND_DISPATCH_GLOBAL_KEY] = fresh;
  globalDispatchStore[MMR_BACKGROUND_DISPATCH_GLOBAL_KEY] = fresh;
  return fresh;
}

/** Install (or clear) the background dispatcher. Called by the async-task tool registration. */
export function registerMmrBackgroundDispatcher(fn: MmrBackgroundDispatcher | undefined): void {
  resolveDispatchStore().dispatcher = fn;
}

export function getMmrBackgroundDispatcher(): MmrBackgroundDispatcher | undefined {
  return resolveDispatchStore().dispatcher;
}

/**
 * Install the live-card resolvers the renderer uses when a NAMED worker
 * tool's result is a background start (the tool's own renderResult has no
 * registry access; this seam supplies it).
 */
export function registerMmrBackgroundCardExtras(extras: BackgroundCardExtras | undefined): void {
  resolveDispatchStore().cardExtras = extras;
}

export function getMmrBackgroundCardExtras(): BackgroundCardExtras | undefined {
  return resolveDispatchStore().cardExtras;
}
