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
import type { BackgroundCardExtras } from "./progress-rendering.js";

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

let dispatcher: MmrBackgroundDispatcher | undefined;
let cardExtras: BackgroundCardExtras | undefined;

/** Install (or clear) the background dispatcher. Called by the async-task tool registration. */
export function registerMmrBackgroundDispatcher(fn: MmrBackgroundDispatcher | undefined): void {
  dispatcher = fn;
}

export function getMmrBackgroundDispatcher(): MmrBackgroundDispatcher | undefined {
  return dispatcher;
}

/**
 * Install the live-card resolvers the renderer uses when a NAMED worker
 * tool's result is a background start (the tool's own renderResult has no
 * registry access; this seam supplies it).
 */
export function registerMmrBackgroundCardExtras(extras: BackgroundCardExtras | undefined): void {
  cardExtras = extras;
}

export function getMmrBackgroundCardExtras(): BackgroundCardExtras | undefined {
  return cardExtras;
}
