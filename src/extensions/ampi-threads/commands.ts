import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getMmrCommand,
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  registerMmrCommand,
  unregisterMmrCommand,
} from "../ampi-core/command-registry.js";
import { MMR_THREAD_SLASH_COMMAND } from "../ampi-core/thread-index.js";
import type { MmrThreadIndexStore } from "./index-store.js";

/**
 * Thread commands: the palette rows and keys in `ampi-core`'s command
 * registry, and the `/ampi-thread` slash command that runs the actions that
 * replace the session. Only a command handler gets Pi's `newSession`, so
 * the palette rows for those actions send `/ampi-thread …` through Pi's
 * prompt path instead of calling it themselves.
 */

export interface MmrThreadCommandHost {
  readonly pi: Pick<ExtensionAPI, "sendUserMessage">;
  readonly store: MmrThreadIndexStore;
  /** Current time as an ISO 8601 string, recorded as the archive date. */
  readonly now: () => string;
}

/** The command `ampi-tui` binds to Ctrl+C Ctrl+C; archive-and-quit ends the same way. */
const QUIT_COMMAND_ID = "ampi.quit";

const AVAILABLE: MmrCommandAvailability = { state: "available" };
const NOTHING_TO_ARCHIVE: MmrCommandAvailability = { state: "hidden" };
const ALREADY_ARCHIVED: MmrCommandAvailability = { state: "unavailable", reason: "this session is already archived" };
const NOT_ARCHIVED: MmrCommandAvailability = { state: "unavailable", reason: "this session is not archived" };

/** Whether the session holds a message. Pi saves a session only once it does, so before that there is nothing to archive. */
export function hasMmrSessionMessages(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

function isArchived(host: MmrThreadCommandHost, ctx: ExtensionContext): boolean {
  return host.store.peek(ctx.sessionManager.getSessionId())?.archived !== undefined;
}

function archiveAvailability(host: MmrThreadCommandHost, ctx: ExtensionContext): MmrCommandAvailability {
  if (!hasMmrSessionMessages(ctx)) return NOTHING_TO_ARCHIVE;
  return isArchived(host, ctx) ? ALREADY_ARCHIVED : AVAILABLE;
}

/** Mark the current session archived. Returns false, changing nothing, when it already is. */
export async function archiveMmrSession(host: MmrThreadCommandHost, ctx: ExtensionContext): Promise<boolean> {
  const sessionId = ctx.sessionManager.getSessionId();
  if ((await host.store.get(sessionId))?.archived !== undefined) return false;
  await host.store.update(sessionId, { archived: host.now() });
  return true;
}

async function quit(ctx: ExtensionContext): Promise<void> {
  const command = getMmrCommand(QUIT_COMMAND_ID);
  if (command) {
    await command.run(ctx);
    return;
  }
  // Without ampi-tui: the same steps its quit command takes.
  if (!ctx.isIdle()) ctx.abort();
  ctx.shutdown();
}

function sendThreadAction(host: MmrThreadCommandHost, action: string): void {
  host.pi.sendUserMessage(`/${MMR_THREAD_SLASH_COMMAND} ${action}`, { expandPromptTemplates: true });
}

/** Handler of `/ampi-thread new` and `/ampi-thread archive`. */
export function createMmrThreadSlashHandler(host: MmrThreadCommandHost) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const action = args.trim();
    if (action === "new") {
      await ctx.newSession();
      return;
    }
    if (action === "archive") {
      if (!hasMmrSessionMessages(ctx)) {
        ctx.ui.notify("Nothing to archive: this session has no messages yet.", "info");
        return;
      }
      if (!(await archiveMmrSession(host, ctx))) {
        ctx.ui.notify("This session is already archived.", "info");
        return;
      }
      await ctx.newSession({
        withSession: async (next) => next.ui.notify("Archived the previous session.", "info"),
      });
      return;
    }
    ctx.ui.notify(`Usage: /${MMR_THREAD_SLASH_COMMAND} new | archive`, "warning");
  };
}

export function createMmrThreadCommands(host: MmrThreadCommandHost): MmrCommandDefinition[] {
  return [
    {
      id: "thread.new",
      noun: "thread",
      verb: "new",
      description: "Start a new session, as /new does",
      run: () => sendThreadAction(host, "new"),
    },
    {
      id: "thread.archive",
      noun: "thread",
      verb: "archive and new",
      description: "Archive and start a new session",
      defaultKey: "ctrl+c ctrl+n",
      availability: (ctx) => archiveAvailability(host, ctx),
      run: () => sendThreadAction(host, "archive"),
    },
    {
      id: "thread.unarchive",
      noun: "thread",
      verb: "unarchive",
      description: "Take this session out of the archive",
      availability: (ctx) => (isArchived(host, ctx) ? AVAILABLE : NOT_ARCHIVED),
      run: async (ctx) => {
        await host.store.update(ctx.sessionManager.getSessionId(), { archived: null });
        ctx.ui.notify("This session is no longer archived.", "info");
      },
    },
    {
      id: "thread.archiveAndQuit",
      noun: "thread",
      verb: "archive and quit",
      description: "Archive and quit",
      defaultKey: "ctrl+c ctrl+e",
      availability: (ctx) => archiveAvailability(host, ctx),
      run: async (ctx) => {
        await archiveMmrSession(host, ctx);
        await quit(ctx);
      },
    },
  ];
}

/** Register the thread commands. Returns a function that unregisters them. */
export function registerMmrThreadCommands(host: MmrThreadCommandHost): () => void {
  const commands = createMmrThreadCommands(host);
  for (const command of commands) registerMmrCommand(command);
  return () => {
    for (const command of commands) unregisterMmrCommand(command.id);
  };
}
