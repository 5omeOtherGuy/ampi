import { isRecord } from "../ampi-core/internal/json.js";
import type { MmrWorkerMessage } from "./runner.js";

export const MMR_WORKER_TRAIL_LIMIT = 32;
const MMR_WORKER_TRAIL_PREVIEW_CHAR_LIMIT = 180;
const MMR_WORKER_TRAIL_TEXT_CHAR_LIMIT = 4_000;

export type MmrWorkerTrailItem =
  | { type: "user"; text: string; imageCount?: number }
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      toolName: string;
      status: "running" | "completed" | "failed";
      args?: unknown;
      argsPreview?: string;
      updatePreview?: string;
      resultPreview?: string;
      isError?: boolean;
    }
  | { type: "toolResult"; toolCallId?: string; toolName?: string; text?: string; imageCount?: number; isError?: boolean }
  | { type: "bashExecution"; command?: string; output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean }
  | { type: "compactionSummary"; summary: string; tokensBefore?: number }
  | { type: "branchSummary"; summary: string }
  | { type: "custom"; customType?: string; text?: string; imageCount?: number }
  | { type: "skillInvocation"; name?: string; location?: string; text?: string };

interface ContentPreview {
  text: string;
  imageCount: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncatePreview(text: string, limit = MMR_WORKER_TRAIL_PREVIEW_CHAR_LIMIT): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

function previewUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return truncatePreview(value);
  if (value === undefined || value === null) return undefined;
  try {
    return truncatePreview(JSON.stringify(value));
  } catch {
    return truncatePreview(String(value));
  }
}

function previewToolResult(value: unknown): string | undefined {
  if (isRecord(value) && Array.isArray(value.content)) {
    for (const entry of value.content) {
      if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
        return truncatePreview(entry.text);
      }
    }
  }
  return previewUnknown(value);
}

export function copyMmrWorkerTrailItem(item: MmrWorkerTrailItem): MmrWorkerTrailItem {
  if (item.type !== "tool") return { ...item };
  const copy: Extract<MmrWorkerTrailItem, { type: "tool" }> = {
    type: "tool",
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    status: item.status,
  };
  if (item.args !== undefined) copy.args = structuredClone(item.args);
  if (item.argsPreview !== undefined) copy.argsPreview = item.argsPreview;
  if (item.updatePreview !== undefined) copy.updatePreview = item.updatePreview;
  if (item.resultPreview !== undefined) copy.resultPreview = item.resultPreview;
  if (item.isError !== undefined) copy.isError = item.isError;
  return copy;
}

function truncateTrailText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MMR_WORKER_TRAIL_TEXT_CHAR_LIMIT) return normalized;
  return `${normalized.slice(0, Math.max(0, MMR_WORKER_TRAIL_TEXT_CHAR_LIMIT - 1))}…`;
}

function previewContentParts(content: unknown): ContentPreview {
  const textParts: string[] = [];
  let imageCount = 0;

  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        textParts.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
        continue;
      }
      if (part.type === "image") imageCount += 1;
    }
  }

  return {
    text: truncateTrailText(textParts.join("\n\n")),
    imageCount,
  };
}

export interface MmrWorkerTrailAggregator {
  captureMessage(message: MmrWorkerMessage): void;
  captureToolResult(message: MmrWorkerMessage): void;
  startTool(event: Record<string, unknown>): boolean;
  updateTool(event: Record<string, unknown>): boolean;
  endTool(event: Record<string, unknown>): boolean;
  snapshot(): MmrWorkerTrailItem[];
}

export function createMmrWorkerTrailAggregator(
  limit = MMR_WORKER_TRAIL_LIMIT,
): MmrWorkerTrailAggregator {
  const workerTrail: MmrWorkerTrailItem[] = [];
  const workerTrailToolIndexes = new Map<string, number>();

  const reindexWorkerTrailTools = () => {
    workerTrailToolIndexes.clear();
    workerTrail.forEach((item, index) => {
      if (item.type === "tool") workerTrailToolIndexes.set(item.toolCallId, index);
    });
  };

  const trimWorkerTrail = () => {
    let shifted = false;
    while (workerTrail.length > limit) {
      workerTrail.shift();
      shifted = true;
    }
    if (shifted) reindexWorkerTrailTools();
  };

  const pushWorkerTrail = (item: MmrWorkerTrailItem) => {
    workerTrail.push(copyMmrWorkerTrailItem(item));
    trimWorkerTrail();
    if (item.type === "tool") reindexWorkerTrailTools();
  };

  const upsertWorkerTrailTool = (item: Extract<MmrWorkerTrailItem, { type: "tool" }>) => {
    const index = workerTrailToolIndexes.get(item.toolCallId);
    if (index !== undefined && workerTrail[index]?.type === "tool") {
      workerTrail[index] = item;
      return;
    }
    pushWorkerTrail(item);
  };

  const getExistingToolItem = (toolCallId: string): Extract<MmrWorkerTrailItem, { type: "tool" }> | undefined => {
    const index = workerTrailToolIndexes.get(toolCallId);
    if (index === undefined) return undefined;
    const existing = workerTrail[index];
    return existing?.type === "tool" ? existing : undefined;
  };

  const pushUserTrail = (text: string, imageCount: number) => {
    const normalized = truncateTrailText(text);
    if (!normalized && imageCount <= 0) return;
    const item: Extract<MmrWorkerTrailItem, { type: "user" }> = { type: "user", text: normalized };
    if (imageCount > 0) item.imageCount = imageCount;
    pushWorkerTrail(item);
  };

  const captureUserTrail = (message: MmrWorkerMessage) => {
    // Pi's parseSkillBlock is anchored to the whole user message; mirror that
    // here so literal `<skill ...>` XML embedded in user prose is rendered as
    // ordinary user text instead of being split into a skillInvocation row.
    // Build the raw concatenated text without truncation so the closing
    // `</skill>` tag is still visible when a skill body exceeds the trail
    // truncation cap.
    const rawParts: string[] = [];
    let imageCount = 0;
    if (typeof message.content === "string") {
      rawParts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "string") {
          rawParts.push(part);
          continue;
        }
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          rawParts.push(part.text);
          continue;
        }
        if (part.type === "image") imageCount += 1;
      }
    }
    const rawText = rawParts.join("\n\n");

    const skillMatch = rawText.match(
      /^<skill name="([^"]+)" location="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]+))?$/,
    );
    if (skillMatch) {
      const skillItem: Extract<MmrWorkerTrailItem, { type: "skillInvocation" }> = {
        type: "skillInvocation",
        name: skillMatch[1] ?? "",
        location: skillMatch[2] ?? "",
        text: truncateTrailText(skillMatch[3] ?? ""),
      };
      pushWorkerTrail(skillItem);
      const trailing = skillMatch[4] ?? "";
      pushUserTrail(trailing, imageCount);
      return;
    }

    pushUserTrail(rawText, imageCount);
  };

  const captureAssistantTrail = (message: MmrWorkerMessage) => {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        pushWorkerTrail({ type: "assistant", text: truncateTrailText(part.text) });
        continue;
      }
      if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
        pushWorkerTrail({ type: "thinking", text: truncateTrailText(part.thinking) });
        continue;
      }
      if (part.type === "toolCall") {
        const toolCallId = readString(part.id) ?? readString(part.toolCallId);
        const toolName = readString(part.name) ?? readString(part.toolName);
        if (!toolCallId || !toolName) continue;
        const prev = getExistingToolItem(toolCallId);
        const item: Extract<MmrWorkerTrailItem, { type: "tool" }> = prev
          ? { ...prev, toolName, status: "running" }
          : { type: "tool", toolCallId, toolName, status: "running" };
        const argsPreview = previewUnknown(part.arguments ?? part.input);
        if (argsPreview) item.argsPreview = argsPreview;
        upsertWorkerTrailTool(item);
      }
    }
  };

  const captureToolResult = (message: MmrWorkerMessage) => {
    const record = message as Record<string, unknown>;
    const toolCallId = readString(record.toolCallId) ?? readString(record.id);
    const toolName = readString(record.toolName) ?? readString(record.name);
    // Only treat `isError` as authoritative when the message actually carries a
    // boolean. A later toolResult message that omits `isError` must not flip
    // an earlier `tool_execution_end` failure back to `completed`.
    const explicitIsError = typeof record.isError === "boolean" ? record.isError : undefined;
    const preview = previewContentParts(message.content);
    const resultPreview = preview.text ? truncatePreview(preview.text) : undefined;

    if (toolCallId) {
      const index = workerTrailToolIndexes.get(toolCallId);
      if (index !== undefined) {
        const existing = workerTrail[index];
        if (existing?.type === "tool") {
          const updated: Extract<MmrWorkerTrailItem, { type: "tool" }> = { ...existing };
          if (explicitIsError !== undefined) {
            updated.status = explicitIsError ? "failed" : "completed";
            updated.isError = explicitIsError;
          }
          if (resultPreview) updated.resultPreview = resultPreview;
          workerTrail[index] = updated;
          return;
        }
      }
    }

    const item: Extract<MmrWorkerTrailItem, { type: "toolResult" }> = { type: "toolResult" };
    if (toolCallId) item.toolCallId = toolCallId;
    if (toolName) item.toolName = toolName;
    if (preview.text) item.text = preview.text;
    if (preview.imageCount > 0) item.imageCount = preview.imageCount;
    if (explicitIsError !== undefined) item.isError = explicitIsError;
    if (item.toolName || item.text || item.imageCount) pushWorkerTrail(item);
  };

  const captureBashExecutionTrail = (message: MmrWorkerMessage) => {
    const record = message as Record<string, unknown>;
    const command = readString(record.command);
    const output = readString(record.output);
    if (!command && !output) return;
    const item: Extract<MmrWorkerTrailItem, { type: "bashExecution" }> = { type: "bashExecution" };
    if (command) item.command = command;
    if (output) item.output = truncateTrailText(output);
    const exitCode = optionalNumber(record.exitCode);
    if (exitCode !== undefined) item.exitCode = exitCode;
    if (typeof record.cancelled === "boolean") item.cancelled = record.cancelled;
    if (typeof record.truncated === "boolean") item.truncated = record.truncated;
    pushWorkerTrail(item);
  };

  const captureCustomTrail = (message: MmrWorkerMessage) => {
    const record = message as Record<string, unknown>;
    if (record.display === false) return;
    const preview = previewContentParts(message.content);
    const item: Extract<MmrWorkerTrailItem, { type: "custom" }> = { type: "custom" };
    const customType = readString(record.customType);
    if (customType) item.customType = customType;
    if (preview.text) item.text = preview.text;
    if (preview.imageCount > 0) item.imageCount = preview.imageCount;
    if (item.customType || item.text || item.imageCount) pushWorkerTrail(item);
  };

  const captureMessage = (message: MmrWorkerMessage) => {
    const record = message as Record<string, unknown>;
    if (message.role === "user") {
      captureUserTrail(message);
      return;
    }
    if (message.role === "assistant") {
      captureAssistantTrail(message);
      return;
    }
    if (message.role === "toolResult" || message.role === "tool") {
      captureToolResult(message);
      return;
    }
    if (message.role === "bashExecution") {
      captureBashExecutionTrail(message);
      return;
    }
    if (message.role === "compactionSummary") {
      const summary = readString(record.summary);
      if (!summary) return;
      const item: Extract<MmrWorkerTrailItem, { type: "compactionSummary" }> = {
        type: "compactionSummary",
        summary: truncateTrailText(summary),
      };
      const tokensBefore = optionalNumber(record.tokensBefore);
      if (tokensBefore !== undefined) item.tokensBefore = tokensBefore;
      pushWorkerTrail(item);
      return;
    }
    if (message.role === "branchSummary") {
      const summary = readString(record.summary);
      if (summary) pushWorkerTrail({ type: "branchSummary", summary: truncateTrailText(summary) });
      return;
    }
    if (message.role === "custom") captureCustomTrail(message);
  };

  const startTool = (event: Record<string, unknown>): boolean => {
    const toolCallId = readString(event.toolCallId);
    const toolName = readString(event.toolName);
    if (!toolCallId || !toolName) return false;
    const prev = getExistingToolItem(toolCallId);
    const item: Extract<MmrWorkerTrailItem, { type: "tool" }> = prev
      ? { ...prev, toolName, status: "running" }
      : { type: "tool", toolCallId, toolName, status: "running" };
    if (event.args !== undefined) item.args = event.args;
    const argsPreview = previewUnknown(event.args);
    if (argsPreview) item.argsPreview = argsPreview;
    upsertWorkerTrailTool(item);
    return true;
  };

  const updateTool = (event: Record<string, unknown>): boolean => {
    const toolCallId = readString(event.toolCallId);
    const toolName = readString(event.toolName);
    if (!toolCallId || !toolName) return false;
    const prev = getExistingToolItem(toolCallId);
    const item: Extract<MmrWorkerTrailItem, { type: "tool" }> = prev
      ? { ...prev, toolName, status: "running" }
      : { type: "tool", toolCallId, toolName, status: "running" };
    if (event.args !== undefined) item.args = event.args;
    const argsPreview = previewUnknown(event.args);
    if (argsPreview) item.argsPreview = argsPreview;
    const updatePreview = previewToolResult(event.partialResult);
    if (updatePreview) item.updatePreview = updatePreview;
    upsertWorkerTrailTool(item);
    return true;
  };

  const endTool = (event: Record<string, unknown>): boolean => {
    const toolCallId = readString(event.toolCallId);
    const toolName = readString(event.toolName);
    if (!toolCallId || !toolName) return false;
    const isError = event.isError === true;
    const prev = getExistingToolItem(toolCallId);
    const item: Extract<MmrWorkerTrailItem, { type: "tool" }> = prev
      ? { ...prev, toolName, status: isError ? "failed" : "completed", isError }
      : { type: "tool", toolCallId, toolName, status: isError ? "failed" : "completed", isError };
    if (event.args !== undefined) item.args = event.args;
    const argsPreview = previewUnknown(event.args);
    if (argsPreview) item.argsPreview = argsPreview;
    const resultPreview = previewToolResult(event.result);
    if (resultPreview) item.resultPreview = resultPreview;
    upsertWorkerTrailTool(item);
    return true;
  };

  return {
    captureMessage,
    captureToolResult,
    startTool,
    updateTool,
    endTool,
    snapshot: () => workerTrail.map(copyMmrWorkerTrailItem),
  };
}
