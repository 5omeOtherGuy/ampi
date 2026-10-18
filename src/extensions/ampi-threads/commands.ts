import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getMmrCommand,
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  registerMmrCommand,
  unregisterMmrCommand,
} from "../ampi-core/command-registry.js";
import { getMmrModeState } from "../ampi-core/runtime.js";
import { listMmrSessionsInScope, type MmrSessionScope } from "../ampi-core/session-catalog.js";
import { MMR_THREAD_SLASH_COMMAND } from "../ampi-core/thread-index.js";
import type { MmrThreadIndexStore } from "./index-store.js";
import { formatMmrThreadMarkdown } from "./markdown.js";
import {
  forgetMmrThreadSwitchTarget,
  type MmrThreadSwitchDirection,
  peekMmrThreadSwitch,
  recordMmrThreadSwitch,
} from "./switch-history.js";

/**
 * Thread commands: the palette rows and keys in `ampi-core`'s command
 * registry, and the `/ampi-thread` slash command that runs the actions that
 * replace the session. Only a command handler gets Pi's `newSession` and
 * `switchSession`, so the palette rows for those actions, and the thread
 * picker in `ampi-tui`, send `/ampi-thread …` through Pi's prompt path
 * instead of calling them themselves.
 */

export interface MmrThreadCommandHost {
  readonly pi: Pick<ExtensionAPI, "sendUserMessage">;
  readonly store: MmrThreadIndexStore;
  /** Current time as an ISO 8601 string, recorded as the archive date. */
  readonly now: () => string;
  /** Put text on the clipboard. */
  readonly copyText: (text: string) => Promise<void>;
}

/** The command `ampi-tui` binds to Ctrl+C Ctrl+C; archive-and-quit ends the same way. */
const QUIT_COMMAND_ID = "ampi.quit";

const AVAILABLE: MmrCommandAvailability = { state: "available" };
const NOTHING_TO_ARCHIVE: MmrCommandAvailability = { state: "hidden" };
const NO_MESSAGES: MmrCommandAvailability = { state: "unavailable", reason: "this session has no messages yet" };
const ALREADY_ARCHIVED: MmrCommandAvailability = { state: "unavailable", reason: "this session is already archived" };
const NOT_ARCHIVED: MmrCommandAvailability = { state: "unavailable", reason: "this session is not archived" };
const NO_SWITCH_REASON: Readonly<Record<MmrThreadSwitchDirection, string>> = {
  previous: "no session to go back to",
  next: "no session to go forward to",
};
const USAGE = `Usage: /${MMR_THREAD_SLASH_COMMAND} new | archive | switch <session id> | previous | next`;

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

/** The session file to come back to, or `undefined` while the session is unsaved (no messages) or kept in memory. */
function reopenableSessionFile(ctx: ExtensionContext): string | undefined {
  const file = ctx.sessionManager.getSessionFile();
  return file !== undefined && hasMmrSessionMessages(ctx) ? file : undefined;
}

function switchAvailability(ctx: ExtensionContext, direction: MmrThreadSwitchDirection): MmrCommandAvailability {
  return peekMmrThreadSwitch(direction, ctx.sessionManager.getSessionFile()) === undefined
    ? { state: "unavailable", reason: NO_SWITCH_REASON[direction] }
    : AVAILABLE;
}

/** Switch to the session in `target` through Pi, and record the switch once Pi has made it. */
async function switchToSession(
  ctx: ExtensionCommandContext,
  target: string,
  direction?: MmrThreadSwitchDirection,
): Promise<void> {
  // Pi would start a new session at a path that no longer exists.
  if (!existsSync(target)) {
    forgetMmrThreadSwitchTarget(target);
    ctx.ui.notify("That session no longer exists.", "warning");
    return;
  }
  const from = reopenableSessionFile(ctx);
  try {
    const result = await ctx.switchSession(target);
    if (!result.cancelled) recordMmrThreadSwitch(from, target, direction);
  } catch (error) {
    ctx.ui.notify(`Could not switch sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function switchById(ctx: ExtensionCommandContext, id: string): Promise<void> {
  // The picker mostly offers this workspace's sessions, so try those before reading every workspace.
  const find = async (scope: MmrSessionScope) => (await listMmrSessionsInScope(ctx.sessionManager, scope)).find((info) => info.id === id);
  const session = (await find("workspace")) ?? (await find("all"));
  if (!session) {
    ctx.ui.notify(`No session has the id ${id}.`, "warning");
    return;
  }
  if (session.id === ctx.sessionManager.getSessionId()) {
    ctx.ui.notify("That is the current session.", "info");
    return;
  }
  await switchToSession(ctx, session.path);
}

async function switchThroughHistory(ctx: ExtensionCommandContext, direction: MmrThreadSwitchDirection): Promise<void> {
  const target = peekMmrThreadSwitch(direction, ctx.sessionManager.getSessionFile());
  if (target === undefined) {
    ctx.ui.notify(`Nothing to switch to: ${NO_SWITCH_REASON[direction]}.`, "info");
    return;
  }
  await switchToSession(ctx, target, direction);
}

/** Copy the current branch of the session as Markdown, with a notice either way. */
async function copyMarkdown(host: MmrThreadCommandHost, ctx: ExtensionContext): Promise<void> {
  const header = ctx.sessionManager.getHeader();
  // The branch alone, since the current entry need not be the last one; the
  // session's name may sit on another branch.
  const markdown = formatMmrThreadMarkdown([...(header ? [header] : []), ...ctx.sessionManager.getBranch()], {
    title: ctx.sessionManager.getSessionName(),
    mode: getMmrModeState()?.mode,
  });
  try {
    await host.copyText(markdown);
  } catch (error) {
    ctx.ui.notify(`Could not copy the thread: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  ctx.ui.notify("Copied the thread as Markdown", "info");
}

/** Handler of `/ampi-thread new`, `archive`, `switch <session id>`, `previous` and `next`. */
export function createMmrThreadSlashHandler(host: MmrThreadCommandHost) {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const [action = "", ...rest] = args.trim().split(/\s+/);
    if (action === "switch" && rest.length === 1) {
      await switchById(ctx, rest[0]!);
      return;
    }
    if ((action === "previous" || action === "next") && rest.length === 0) {
      await switchThroughHistory(ctx, action);
      return;
    }
    if (rest.length > 0) {
      ctx.ui.notify(USAGE, "warning");
      return;
    }
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
    ctx.ui.notify(USAGE, "warning");
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
    {
      id: "thread.switchToPrevious",
      noun: "thread",
      verb: "switch to previous",
      description: "Go back to the session you switched away from",
      availability: (ctx) => switchAvailability(ctx, "previous"),
      run: () => sendThreadAction(host, "previous"),
    },
    {
      id: "thread.switchToNext",
      noun: "thread",
      verb: "switch to next",
      description: "Go forward again after switching to the previous session",
      availability: (ctx) => switchAvailability(ctx, "next"),
      run: () => sendThreadAction(host, "next"),
    },
    {
      id: "thread.copyMarkdown",
      noun: "thread",
      verb: "copy markdown",
      description: "Copy this session to the clipboard as Markdown",
      availability: (ctx) => (hasMmrSessionMessages(ctx) ? AVAILABLE : NO_MESSAGES),
      run: (ctx) => copyMarkdown(host, ctx),
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
