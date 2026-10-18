import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMmrCommand } from "../ampi-core/command-registry.js";
import { getMmrPromptQueue, removeMmrQueuedPrompt } from "../ampi-core/prompt-queue.js";
import type { MmrGuiBridge } from "./bridge.js";

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
 * A request that cannot act now answers 409 with the reason; a malformed one
 * answers 400.
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

const ok = (body: Record<string, unknown> = {}): MmrGuiCommandResult => ({ status: 200, body: { ok: true, ...body } });
const conflict = (error: string): MmrGuiCommandResult => ({ status: 409, body: { error } });
const invalid = (error: string): MmrGuiCommandResult => ({ status: 400, body: { error } });

function record(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createMmrGuiCommands(pi: Pick<ExtensionAPI, "sendUserMessage">, bridge: MmrGuiBridge): MmrGuiCommands {
  return {
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
