import { buildSessionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MmrContextAnalysis, MmrContextSection } from "../ampi-core/thread-reports.js";

/**
 * What fills a session's context window, section by section: the Analyze
 * Context overlay's numbers.
 *
 * Pi records the system prompt and the tool declarations it sends as system
 * messages in the session, so the analysis reads them from the entries:
 *
 * - AGENTS.md files: the `<project_instructions>` blocks Pi puts in the
 *   prompt, one per file.
 * - Loaded skills: the `<available_skills>` list, one `<skill>` per skill.
 * - System prompt: the rest of the prompt.
 * - Built-in tools and MCP tools: the declarations of the tools sent, MCP
 *   tools told apart by name.
 * - Compaction summary and messages: the conversation Pi sends now, after
 *   the latest compaction.
 *
 * Before the session's first request it holds no system message; the prompt
 * and tools Pi would send now stand in.
 *
 * Every count is an estimate of four characters to a token, the estimate Pi
 * itself uses for compaction (`estimateTokens`).
 */

/** A tool declaration as the model receives it. */
export interface MmrToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface MmrContextAnalysisInput {
  /** The current branch's entries, root first (`sessionManager.getBranch()`). */
  readonly entries: readonly SessionEntry[];
  /** `provider/model`, shown above the sections. */
  readonly model?: string;
  readonly contextWindow?: number;
  /** Tokens Pi measured at the last response (`ctx.getContextUsage().tokens`). */
  readonly measuredTokens?: number;
  /** Names of the tools that come from MCP servers. */
  readonly mcpTools?: ReadonlySet<string>;
  /** The prompt and tools Pi would send now, used while the branch records none. */
  readonly pending?: { readonly systemPrompt: string; readonly tools: readonly MmrToolDeclaration[] };
}

const CHARS_PER_TOKEN = 4;
const tokensOf = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const PROJECT_INSTRUCTIONS = /<project_instructions\b[^>]*>[\s\S]*?<\/project_instructions>/g;
const AVAILABLE_SKILLS = /<available_skills>[\s\S]*?<\/available_skills>/g;
const SKILL = /<skill>/g;

interface SystemState {
  readonly text: string;
  readonly tools: readonly MmrToolDeclaration[];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

interface SystemMessageShape {
  readonly role: "system";
  readonly content?: unknown;
  readonly sections?: Record<string, string | null>;
  readonly toolsAdded?: readonly MmrToolDeclaration[];
  readonly toolsRemoved?: readonly { readonly name: string }[];
}

/**
 * Replay the system messages the way Pi does: the first gives the prompt and
 * tools, later ones replace sections by name (`null` removes one), add
 * instructions, and add or remove tools.
 */
function replaySystem(messages: readonly SystemMessageShape[]): SystemState | undefined {
  if (messages.length === 0) return undefined;
  const contents: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, MmrToolDeclaration>();
  for (const message of messages) {
    const content = contentText(message.content);
    if (content) contents.push(content);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return { text: [...contents, ...sections.values()].filter((part) => part.length > 0).join("\n\n"), tools: [...tools.values()] };
}

function declarationTokens(tools: readonly MmrToolDeclaration[]): number {
  return tools.reduce(
    (sum, tool) => sum + tokensOf(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    0,
  );
}

function matchedChars(text: string, pattern: RegExp): { count: number; chars: number } {
  const matches = text.match(pattern) ?? [];
  return { count: matches.length, chars: matches.reduce((sum, match) => sum + match.length, 0) };
}

/** Estimate what each part of the context takes, and the share of the window. */
export function analyzeMmrContext(input: MmrContextAnalysisInput): MmrContextAnalysis {
  const { messages } = buildSessionContext([...input.entries]);
  const system: SystemMessageShape[] = [];
  let compactionTokens = 0;
  let messageTokens = 0;
  for (const message of messages) {
    if (message.role === "system") system.push(message as SystemMessageShape);
    else if (message.role === "compactionSummary") compactionTokens += estimateTokens(message);
    else messageTokens += estimateTokens(message);
  }
  const state = replaySystem(system) ?? { text: input.pending?.systemPrompt ?? "", tools: input.pending?.tools ?? [] };

  const agents = matchedChars(state.text, PROJECT_INSTRUCTIONS);
  const skillLists = state.text.match(AVAILABLE_SKILLS) ?? [];
  const skills = { count: skillLists.reduce((sum, list) => sum + (list.match(SKILL)?.length ?? 0), 0), chars: skillLists.join("").length };
  const mcp = input.mcpTools ?? new Set<string>();
  const builtinTools = state.tools.filter((tool) => !mcp.has(tool.name));
  const mcpTools = state.tools.filter((tool) => mcp.has(tool.name));

  const sections: MmrContextSection[] = [
    { id: "system-prompt", name: "System prompt", tokens: Math.ceil((state.text.length - agents.chars - skills.chars) / CHARS_PER_TOKEN) },
    { id: "builtin-tools", name: "Built-in tools", tokens: declarationTokens(builtinTools), count: builtinTools.length },
    { id: "agents-files", name: "AGENTS.md files", tokens: Math.ceil(agents.chars / CHARS_PER_TOKEN), count: agents.count },
    { id: "mcp-tools", name: "MCP tools", tokens: declarationTokens(mcpTools), count: mcpTools.length },
    { id: "loaded-skills", name: "Loaded skills", tokens: Math.ceil(skills.chars / CHARS_PER_TOKEN), count: skills.count },
    { id: "compaction-summary", name: "Compaction summary", tokens: compactionTokens },
    { id: "messages", name: "Messages", tokens: messageTokens },
  ];
  return {
    model: input.model,
    contextWindow: input.contextWindow !== undefined && input.contextWindow > 0 ? input.contextWindow : undefined,
    sections,
    totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
    measuredTokens: input.measuredTokens,
    compactionCount: input.entries.filter((entry) => entry.type === "compaction").length,
  };
}
