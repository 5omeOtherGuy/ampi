import type {
  MmrActiveToolManifestEntry,
  MmrPromptAssemblyResult,
} from "./types.js";
import type { MmrSubagentPromptAssemblyResult } from "./subagent-prompt-assembly.js";

/**
 * Minimal structural input the debug renderer needs. Both
 * `MmrPromptAssemblyResult` (user-facing modes) and
 * `MmrSubagentPromptAssemblyResult` (subagent surfaces) satisfy it,
 * which keeps the renderer mode/subagent-agnostic.
 */
export interface MmrPromptDebugFixtureInput {
  systemPrompt: string;
  activeToolManifest: readonly MmrActiveToolManifestEntry[];
}

/**
 * Developer-only renderer that flattens a prompt-assembly result into a stable
 * Markdown artifact for review and snapshot testing.
 *
 * The renderer is mode- and provider-agnostic: it never re-resolves the tool
 * registry, never filters the manifest, and never inspects `blocks`. Callers
 * are responsible for assembling an active-only manifest — deferred, planned,
 * gated, and disabled tools must not appear in the input.
 *
 * Accepts either a user-facing `MmrPromptAssemblyResult` or a subagent
 * `MmrSubagentPromptAssemblyResult`; both expose the
 * `MmrPromptDebugFixtureInput` shape the renderer reads.
 *
 * The output answers a single question: "What does the model effectively know
 * for this mode and active tool set?" It is not a provider payload and does
 * not imply that Pi literally injected every tool description into
 * `event.systemPrompt`.
 */
export function renderMmrPromptDebugFixture(
  result: MmrPromptDebugFixtureInput | MmrPromptAssemblyResult | MmrSubagentPromptAssemblyResult,
): string {
  const lines: string[] = [];

  lines.push("=== System Messages ===");
  lines.push("");
  lines.push(result.systemPrompt);
  lines.push("");
  lines.push("=== Tools ===");
  lines.push("");

  for (const tool of result.activeToolManifest) {
    appendToolEntry(lines, tool);
  }

  return lines.join("\n");
}

function appendToolEntry(lines: string[], tool: MmrActiveToolManifestEntry): void {
  lines.push(`# ${tool.name}`);
  lines.push("");
  lines.push(`Owner: ${tool.owner}`);
  lines.push("");

  if (tool.promptSnippet) {
    lines.push(`Prompt snippet: ${tool.promptSnippet}`);
    lines.push("");
  }

  if (tool.promptGuidelines.length > 0) {
    lines.push("Prompt guidelines:");
    for (const guideline of tool.promptGuidelines) {
      lines.push(`- ${guideline}`);
    }
    lines.push("");
  }

  lines.push("Description:");
  lines.push(tool.description);
  lines.push("");

  lines.push("Parameters:");
  lines.push("```json");
  lines.push(stringifyMmrToolSchema(tool.schema));
  lines.push("```");
  lines.push("");
}

/**
 * Deterministic JSON stringifier for tool schemas. Object keys are sorted
 * alphabetically at every depth so two semantically equal schemas produce
 * byte-identical snapshot output regardless of key authoring order. Array
 * element order is preserved because schemas frequently encode ordered
 * `required`/`enum` lists.
 *
 * Indentation is two spaces. Empty objects and arrays render compactly as
 * `{}` and `[]` so snapshots do not gain noise lines when a schema branch is
 * empty.
 */
export function stringifyMmrToolSchema(value: unknown): string {
  return formatJson(value, 0);
}

function formatJson(value: unknown, indent: number): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return formatArray(value, indent);
  if (typeof value === "object") return formatObject(value as Record<string, unknown>, indent);
  // Functions, undefined, symbols, bigints: stringify defensively so callers
  // see "null" in the snapshot rather than crashing the renderer.
  return "null";
}

function formatArray(arr: readonly unknown[], indent: number): string {
  if (arr.length === 0) return "[]";
  const childIndent = " ".repeat((indent + 1) * 2);
  const closingIndent = " ".repeat(indent * 2);
  const items = arr.map((item) => `${childIndent}${formatJson(item, indent + 1)}`);
  return `[\n${items.join(",\n")}\n${closingIndent}]`;
}

function formatObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "{}";
  const childIndent = " ".repeat((indent + 1) * 2);
  const closingIndent = " ".repeat(indent * 2);
  const entries = keys.map((key) => {
    const rendered = formatJson(obj[key], indent + 1);
    return `${childIndent}${JSON.stringify(key)}: ${rendered}`;
  });
  return `{\n${entries.join(",\n")}\n${closingIndent}}`;
}
