import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MMR_THREAD_SLASH_COMMAND, registerMmrThreadIndex } from "../ampi-core/thread-index.js";
import {
  archiveMmrSession,
  createMmrThreadSlashHandler,
  hasMmrSessionMessages,
  type MmrThreadCommandHost,
  registerMmrThreadCommands,
} from "./commands.js";
import { loadMmrThreadsSettings, type MmrThreadsSettings } from "./config.js";
import { createMmrThreadIndexStore, type MmrThreadIndexStore, type MmrThreadIndexStoreOptions } from "./index-store.js";

export interface MmrThreadsFactoryOverrides {
  loadSettings?: () => MmrThreadsSettings;
  /** Builds the index store; receives the warning callback the extension wires to the UI. */
  createStore?: (options: Pick<MmrThreadIndexStoreOptions, "onWarning">) => MmrThreadIndexStore;
  /** Archive timestamps; defaults to the current time. */
  now?: () => string;
}

export function createMmrThreadsExtension(overrides: MmrThreadsFactoryOverrides = {}) {
  return function ampiThreadsExtension(pi: ExtensionAPI): void {
    const settings = overrides.loadSettings ? overrides.loadSettings() : loadMmrThreadsSettings(process.cwd());
    if (!settings.enabled) return;

    let ctx: ExtensionContext | undefined;
    const onWarning = (message: string) => {
      if (ctx?.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[ampi-threads] ${message}`);
    };
    const store = overrides.createStore ? overrides.createStore({ onWarning }) : createMmrThreadIndexStore({ onWarning });
    const host: MmrThreadCommandHost = { pi, store, now: overrides.now ?? (() => new Date().toISOString()) };

    // The store works in every run mode; the commands only matter where a
    // palette or key dispatcher shows them, and are harmless elsewhere.
    const releaseIndex = registerMmrThreadIndex(store);
    const unregisterCommands = registerMmrThreadCommands(host);
    pi.registerCommand(MMR_THREAD_SLASH_COMMAND, {
      description: "Start a new session, or archive this one and start a new one (used by the thread commands)",
      handler: createMmrThreadSlashHandler(host),
    });

    pi.on("session_start", async (_event, next) => {
      ctx = next;
      // Load this session's record, so the commands' availability (read
      // synchronously) knows whether it is archived.
      try {
        await store.get(next.sessionManager.getSessionId());
      } catch (error) {
        onWarning(`Could not read the thread index: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    pi.on("session_shutdown", async (event, current) => {
      try {
        // Quitting an interactive session, by any route, archives it when
        // asked to. Switching sessions, reloading, and print, JSON and RPC
        // runs (subagent workers included) never do.
        if (settings.autoArchiveOnQuit && event.reason === "quit" && current.mode === "tui" && hasMmrSessionMessages(current)) {
          await archiveMmrSession(host, current).catch((error: unknown) => {
            // The terminal is already closed, so the error goes to stderr.
            console.warn(`[ampi-threads] Could not archive the session: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      } finally {
        unregisterCommands();
        releaseIndex();
        ctx = undefined;
      }
    });
  };
}

export const createAmpiThreadsExtension = createMmrThreadsExtension;

const ampiThreadsExtension = createMmrThreadsExtension();

export default ampiThreadsExtension;
