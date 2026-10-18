import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMmrCommand } from "../ampi-core/command-registry.js";
import { getMmrPromptQueue, removeMmrQueuedPrompt } from "../ampi-core/prompt-queue.js";
import { getMmrModeState } from "../ampi-core/runtime.js";
import { getMmrThreadIndex } from "../ampi-core/thread-index.js";
import { getMmrThreadReports } from "../ampi-core/thread-reports.js";
import type { MmrGuiBridge } from "./bridge.js";
import type { MmrGuiSessions } from "./sessions.js";

/**
 * What the web GUI's composer can do to the running session. Every write
 * goes through the Pi session of the terminal process that serves the page,
 * the same way the terminal's own keys go:
 *
 * | Route              | Body                          | Effect |
 * | ------------------ | ----------------------------- | ------ |
 * | `/api/send`        | `{ text, deliverAs? }`        | idle: a new prompt; busy: steers the turn (`"steer"`, the default) or waits for it to end (`"followUp"`), through `pi.sendUserMessage` |
 * | `/api/dequeue`     | `{ kind, index, text }`       | takes one queued message back, through ampi-core's prompt-queue seam |
 * | `/api/steer-next`  | `{}`                          | runs the `prompt.steerQueuedMessage` command |
 * | `/api/interrupt`   | `{}`                          | runs the `thread.interrupt` command, or `ctx.abort()` without it |
 *
 * And the title bar's More Actions, for any listed session:
 *
 * | Route              | Body                          | Effect |
 * | ------------------ | ----------------------------- | ------ |
 * | `/api/markdown`    | `{ sessionId }`               | answers `{ markdown }`: the session's current branch through ampi-threads' formatter |
 * | `/api/archive`     | `{ sessionId, archived }`     | sets or clears the session's archive date in the thread index |
 * | `/api/rename`      | `{ sessionId, name }`         | renames the session this process runs with `pi.setSessionName`, as the user's title; other sessions are renamed where they run |
 *
 * A request that cannot act now answers 409 with the reason; a malformed one
 * answers 400; a session the catalogue does not list answers 404.
 */

export interface MmrGuiCommandResult {
  status: number;
  body: Record<string, unknown>;
}

export type MmrGuiCommands = Readonly<Record<string, (body: unknown) => MmrGuiCommandResult | Promise<MmrGuiCommandResult>>>;

/** Longest prompt the composer may send, in UTF-16 code units. */
export const MMR_GUI_MAX_PROMPT_LENGTH = 100_000;

const STEER_COMMAND_ID = "prompt.steerQueuedMessage";
const INTERRUPT_COMMAND_ID = "thread.interrupt";

/** Longest session name the title bar may set. */
export const MMR_GUI_MAX_NAME_LENGTH = 200;

const ok = (body: Record<string, unknown> = {}): MmrGuiCommandResult => ({ status: 200, body: { ok: true, ...body } });
const conflict = (error: string): MmrGuiCommandResult => ({ status: 409, body: { error } });
const invalid = (error: string): MmrGuiCommandResult => ({ status: 400, body: { error } });
const unknownSession: MmrGuiCommandResult = { status: 404, body: { error: "No such session." } };

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export interface MmrGuiCommandOptions {
  /** Archive dates; defaults to the current time. */
  now?: () => string;
}

export function createMmrGuiCommands(
  pi: Pick<ExtensionAPI, "sendUserMessage" | "setSessionName">,
  bridge: MmrGuiBridge,
  sessions: MmrGuiSessions,
  options: MmrGuiCommandOptions = {},
): MmrGuiCommands {
  const now = options.now ?? (() => new Date().toISOString());

  /** The session id from a body, when this process runs it or the catalogue lists it. */
  async function knownSession(body: unknown): Promise<{ id: string; live: boolean } | MmrGuiCommandResult> {
    const { sessionId } = record(body);
    if (typeof sessionId !== "string" || sessionId === "") return invalid("Name the session by its id.");
    const ctx = bridge.context();
    if (ctx && ctx.sessionManager.getSessionId() === sessionId) return { id: sessionId, live: true };
    return (await sessions.find(sessionId)) ? { id: sessionId, live: false } : unknownSession;
  }

  return {
    async markdown(body) {
      const target = await knownSession(body);
      if ("status" in target) return target;
      const reports = getMmrThreadReports();
      if (!reports) return conflict("Copying as Markdown needs the ampi-threads extension.");
      const ctx = bridge.context();
      if (target.live && ctx) {
        const manager = ctx.sessionManager;
        const header = manager.getHeader();
        const markdown = reports.markdown([...(header ? [header] : []), ...manager.getBranch()], {
          title: manager.getSessionName(),
          mode: getMmrModeState()?.mode,
        });
        return ok({ markdown });
      }
      const info = await sessions.find(target.id);
      if (!info) return unknownSession;
      const { header, branch } = await sessions.read(info);
      return ok({ markdown: reports.markdown([...(header ? [header] : []), ...branch], { title: info.name }) });
    },
    async archive(body) {
      const { archived } = record(body);
      if (typeof archived !== "boolean") return invalid("archived must be true or false.");
      const target = await knownSession(body);
      if ("status" in target) return target;
      const index = getMmrThreadIndex();
      if (!index) return conflict("Archiving needs the ampi-threads extension.");
      await index.update(target.id, { archived: archived ? now() : null });
      return ok({ archived });
    },
    async rename(body) {
      const raw = record(body).name;
      const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
      if (name === "") return invalid("Type a name.");
      if (name.length > MMR_GUI_MAX_NAME_LENGTH) return invalid("The name is too long.");
      const target = await knownSession(body);
      if ("status" in target) return target;
      // Only the process that runs a session writes its file.
      if (!target.live) return conflict("Rename this session in the terminal that runs it.");
      pi.setSessionName(name);
      // As the terminal's rename does: a typed title is never replaced by a generated one.
      await getMmrThreadIndex()?.update(target.id, { titleSource: "user" });
      return ok({ name });
    },
    send(body) {
      const { text, deliverAs } = record(body);
      if (typeof text !== "string" || text.trim() === "") return invalid("Type a message to send.");
      if (text.length > MMR_GUI_MAX_PROMPT_LENGTH) return invalid("The message is too long.");
      if (deliverAs !== undefined && deliverAs !== "steer" && deliverAs !== "followUp") return invalid('deliverAs must be "steer" or "followUp".');
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      if (bridge.status().phase === "compacting") return conflict("Pi is compacting the conversation. Send again when it is done.");
      const idle = ctx.isIdle();
      const mode = deliverAs ?? "steer";
      // Pi uses `deliverAs` only while a turn runs, so a turn that starts
      // between the check and the call still gets the message queued.
      // Expanded like a typed prompt, so templates and skills work as in the terminal.
      pi.sendUserMessage(text.trim(), { deliverAs: mode, expandPromptTemplates: true });
      return ok({ delivered: idle ? "prompt" : mode });
    },
    dequeue(body) {
      const { kind, index, text } = record(body);
      if (kind !== "steering" && kind !== "followUp") return invalid('kind must be "steering" or "followUp".');
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || typeof text !== "string") {
        return invalid("Name the queued message by its index and text.");
      }
      if (!bridge.context()) return conflict("The session has ended.");
      if (!getMmrPromptQueue()) return conflict("This session does not show ampi its queue.");
      if (!removeMmrQueuedPrompt(kind, index, text)) return conflict("That message is no longer queued.");
      return ok({ text });
    },
    "steer-next"() {
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      const command = getMmrCommand(STEER_COMMAND_ID);
      if (!command) return conflict("This session cannot steer a queued message.");
      const availability = command.availability?.(ctx) ?? { state: "available" };
      if (availability.state !== "available") return conflict(availability.reason ?? "No queued message can steer now.");
      return Promise.resolve(command.run(ctx)).then(() => ok());
    },
    interrupt() {
      const ctx = bridge.context();
      if (!ctx) return conflict("The session has ended.");
      if (ctx.isIdle()) return conflict("Nothing is running.");
      bridge.interrupted();
      // The terminal's own command, so its status shows the interruption too.
      const command = getMmrCommand(INTERRUPT_COMMAND_ID);
      if (command) return Promise.resolve(command.run(ctx)).then(() => ok());
      ctx.abort();
      return ok();
    },
  };
}
