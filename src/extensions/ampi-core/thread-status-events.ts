import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MmrThreadStatusEvent } from "./thread-status.js";

/**
 * Maps Pi's agent events onto the thread status reducer's events
 * (`thread-status.ts`). Every holder of a reducer subscribes through
 * `onMmrThreadStatusEvents`, so the terminal's prompt box and the live
 * registry follow a turn the same way.
 *
 * | Pi event                         | Reducer events                             |
 * | -------------------------------- | ------------------------------------------ |
 * | `turn_start`                     | `turnStart`                                |
 * | `message_start`                  | none (an assistant message starts a new token count) |
 * | `message_update` (assistant)     | `messageUpdate`: thinking, text or tool call, with the tokens streamed in the current stage |
 * | `tool_execution_start` / `_end`  | `toolStart` / `toolEnd`                    |
 * | `session_before_compact`         | `compactionStart`                          |
 * | `session_compact` / `_failed`    | `compactionEnd` / `compactionFailed`       |
 * | `turn_end`                       | `error` first when the response failed, then `turnEnd` |
 * | `agent_settled`                  | `settled`                                  |
 *
 * The token count is an estimate: the UTF-8 bytes of the deltas streamed
 * since the stage began (thinking, or text and tool calls), four bytes to a
 * token. Pi's providers fill in a message's output usage when it starts or
 * when it ends, not while it streams, so the partial message's usage cannot
 * count up during a stage.
 *
 * Queued messages, interrupts and the quit hint are not Pi agent events;
 * the holder that knows about them applies those reducer events itself.
 */

/** The Pi events the mapping reads, in the order they are subscribed. */
export const MMR_THREAD_STATUS_PI_EVENTS = [
  "turn_start",
  "message_start",
  "message_update",
  "tool_execution_start",
  "tool_execution_end",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "turn_end",
  "agent_settled",
] as const;

export type MmrThreadStatusPiEvent = (typeof MMR_THREAD_STATUS_PI_EVENTS)[number];

export interface MmrThreadStatusEventMapper {
  /** The reducer events for one Pi event, in the order to apply them. */
  map(name: MmrThreadStatusPiEvent, event: unknown): MmrThreadStatusEvent[];
  /** Forget the stage being counted (a new session). */
  reset(): void;
}

type AssistantContent = "text" | "thinking" | "toolCall";

function contentOf(eventType: unknown): AssistantContent | undefined {
  if (typeof eventType !== "string") return undefined;
  if (eventType.startsWith("thinking_")) return "thinking";
  if (eventType.startsWith("text_")) return "text";
  if (eventType.startsWith("toolcall_")) return "toolCall";
  return undefined;
}

/** Bytes per token for the streamed-token estimate. */
const BYTES_PER_TOKEN = 4;

function failed(message: unknown): boolean {
  const record = message as { role?: unknown; stopReason?: unknown } | undefined;
  return record?.role === "assistant" && record.stopReason === "error";
}

export function createMmrThreadStatusEventMapper(): MmrThreadStatusEventMapper {
  /** The stage being counted (`thinking` or `streaming`) and the bytes streamed in it. */
  let stage: "thinking" | "streaming" | undefined;
  let stageBytes = 0;

  function newStage(): void {
    stage = undefined;
    stageBytes = 0;
  }

  return {
    map(name, raw) {
      const event = (raw ?? {}) as Record<string, unknown>;
      switch (name) {
        case "turn_start":
          newStage();
          return [{ type: "turnStart" }];
        case "message_start":
          if ((event.message as { role?: unknown } | undefined)?.role === "assistant") newStage();
          return [];
        case "message_update": {
          const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
          const content = contentOf(update?.type);
          if (!content) return [];
          const nextStage = content === "thinking" ? "thinking" : "streaming";
          if (nextStage !== stage) {
            stage = nextStage;
            stageBytes = 0;
          }
          if (typeof update?.delta === "string") stageBytes += Buffer.byteLength(update.delta, "utf8");
          return [{ type: "messageUpdate", content, outputTokens: Math.ceil(stageBytes / BYTES_PER_TOKEN) }];
        }
        case "tool_execution_start":
          newStage();
          return [{ type: "toolStart", toolCallId: String(event.toolCallId), toolName: String(event.toolName) }];
        case "tool_execution_end":
          return [{ type: "toolEnd", toolCallId: String(event.toolCallId), outcome: event.isError ? "error" : "success" }];
        case "session_before_compact":
          return [{ type: "compactionStart" }];
        case "session_compact":
          return [{ type: "compactionEnd" }];
        case "session_compact_failed":
          return [{ type: "compactionFailed" }];
        case "turn_end":
          return failed(event.message) ? [{ type: "error" }, { type: "turnEnd" }] : [{ type: "turnEnd" }];
        case "agent_settled":
          return [{ type: "settled" }];
      }
    },
    reset: newStage,
  };
}

/** One Pi event as a subscriber sees it: its name, Pi's payload and context, and the mapped reducer events. */
export interface MmrThreadStatusPiUpdate {
  readonly name: MmrThreadStatusPiEvent;
  readonly event: unknown;
  readonly ctx: ExtensionContext;
  readonly events: MmrThreadStatusEvent[];
}

/**
 * Subscribe `listener` to every Pi event in `MMR_THREAD_STATUS_PI_EVENTS`
 * through `mapper`. Returns the mapper, so the caller can reset it.
 */
export function onMmrThreadStatusEvents(
  pi: Pick<ExtensionAPI, "on">,
  listener: (update: MmrThreadStatusPiUpdate) => void,
  mapper: MmrThreadStatusEventMapper = createMmrThreadStatusEventMapper(),
): MmrThreadStatusEventMapper {
  // Pi types `on` per event name; these handlers read their payloads through the mapping.
  const on = pi.on.bind(pi) as unknown as (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => void;
  for (const name of MMR_THREAD_STATUS_PI_EVENTS) {
    on(name, (event, ctx) => listener({ name, event, ctx, events: mapper.map(name, event) }));
  }
  return mapper;
}
