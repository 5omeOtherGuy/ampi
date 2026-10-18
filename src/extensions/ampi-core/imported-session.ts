import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./internal/json.js";

/**
 * Sessions that `ampi threads import` converted from another coding agent are
 * read-only: they record what that agent did, with models Pi has no provider
 * for, so a new turn would mix two agents' work in one transcript. ampi-core
 * owns the guard so that turning optional extensions off cannot lift it:
 * its `input` handler refuses every prompt in such a session, whichever host
 * sent it (the terminal UI, RPC, the SDK, or an extension), before Pi sends
 * anything. Viewing, Markdown export, search and mentions only read the
 * session and keep working.
 */

/** The custom entry type `ampi threads import` writes into every session it creates. */
export const MMR_IMPORT_ENTRY_TYPE = "ampi-import";

/** What a refused prompt shows (with a UI) or writes to stderr (without one). */
export const MMR_IMPORTED_SESSION_NOTICE =
  "This session was imported from another coding agent and is read-only. To continue the work, start a new session and mention this one with @@, or ask the agent to use find_session and read_session.";

/** Whether `entries` (a session's entries, in any order) hold the entry `ampi threads import` writes. */
export function isMmrImportedSession(entries: readonly unknown[]): boolean {
  return entries.some((entry) => isRecord(entry) && entry.type === "custom" && entry.customType === MMR_IMPORT_ENTRY_TYPE);
}

/**
 * Refuse a prompt when the current session is imported: with a UI (the
 * terminal UI or an RPC client) the notice is shown; without one (print and
 * JSON runs) it goes to stderr and the process exit code becomes 1, so a
 * scripted run fails instead of ending quietly. Returns whether it refused.
 */
export function refuseMmrImportedSessionInput(
  ctx: Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): boolean {
  if (!isMmrImportedSession(ctx.sessionManager.getEntries())) return false;
  if (!ctx.hasUI) process.exitCode = 1;
  try {
    if (ctx.hasUI) ctx.ui.notify(MMR_IMPORTED_SESSION_NOTICE, "warning");
    else stderr.write(`ampi: ${MMR_IMPORTED_SESSION_NOTICE}\n`);
  } catch {
    // Pi sends a prompt whose input handler threw, so a notice that cannot be shown must not undo the refusal.
  }
  return true;
}
