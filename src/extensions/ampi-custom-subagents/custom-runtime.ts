import { homedir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isRecord } from "../ampi-core/internal/json.js";
import { registerAmpiOwnedTool } from "../ampi-core/owned-tools.js";
import { getMmrModeStateSnapshot, registerMmrModeExtraToolProvider } from "../ampi-core/runtime.js";
import type { MmrLockedModeKey } from "../ampi-core/types.js";
import { registerMmrSubagentPromptBuilder } from "../ampi-core/subagent-prompt-assembly.js";
import {
  getMmrSubagentProfile,
  registerMmrSubagentProfile,
  type MmrSubagentProfile,
} from "../ampi-core/subagent-profiles.js";
import type { MmrModelPreference } from "../ampi-core/types.js";
import {
  type MmrCustomSubagentDefinition,
  MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS,
  MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES,
  MMR_CUSTOM_SUBAGENT_TOOL_PREFIX,
  discoverMmrCustomSubagentsSync,
  isUnsafeMmrCustomSubagentToolPattern,
  normalizeMmrCustomSubagentToolPatterns,
  parseMmrCustomSubagentMarkdown,
} from "./custom-loader.js";
import {
  type MmrCustomSubagentRecord,
  type ResolvedMmrCustomSubagentRecord,
  getPiOwnedSubagentRoots,
  resolveEnabledMmrCustomSubagents,
} from "./custom-config.js";
import fs, { constants as fsConstants } from "node:fs";
import { getMmrWorkerHost, registerMmrWorkerBinding } from "../ampi-core/worker-host.js";
import type {
  MmrSpawnedSubagentWorkerDetailsBase,
  MmrSubagentRunner,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerToolRunContext,
  MmrWorkerToolSpec,
} from "../ampi-core/worker-contract.js";
import {
  classifyMmrWorkerOutcomeForProfile,
  type MmrWorkerOutcomeStatus,
} from "../ampi-core/worker-outcome.js";
import {
  buildSpawnedFinalDetailsBase,
  buildSpawnedProgressDetailsBase,
} from "../ampi-core/worker-result-shaping.js";
import {
  resolveCtxMmrModelRegistry,
  resolveMmrWorkerModelContextWindowFromCtx,
} from "../ampi-core/worker-model-metadata.js";
import { resolveMmrSubagentInvocation, type MmrSubagentInvocation } from "../ampi-core/subagent-resolver.js";
import { MMR_SUBAGENT_SHARED_DENY_TOOLS } from "../ampi-core/subagent-tool-policy.js";

export const CUSTOM_SUBAGENT_PARAMETERS_SCHEMA = Type.Object(
  {
    task: Type.String({
      description: "The concrete task, question, or request for this custom Markdown subagent.",
    }),
  },
  { additionalProperties: false },
);

export type CustomSubagentParams = Static<typeof CUSTOM_SUBAGENT_PARAMETERS_SCHEMA>;

export interface CustomSubagentDetails extends MmrSpawnedSubagentWorkerDetailsBase {
  worker: string;
  status?: MmrWorkerOutcomeStatus;
  toolName: string;
  definitionName: string;
  filePath: string;
  prompt: string;
  /**
   * User-facing notice emitted when the subagent relied on a fallback for
   * `model`, thinking/effort level, or `tools` (including running with no
   * tools). Recommends the author pin those fields. Absent when all three
   * were declared.
   */
  fallbackNotice?: string;
}

export interface CustomSubagentToolDeps {
  runner?: MmrSubagentRunner;
  outputByteLimit?: number;
}

export interface RegisterMmrCustomSubagentToolsOptions extends CustomSubagentToolDeps {
  cwd?: string;
  homeDir?: string;
  /**
   * Test seam: explicit enabled+in-scope records to register, bypassing the
   * on-disk config + Markdown load. Each entry must carry the record and the
   * already-parsed definition (or a resolvable source `filePath`).
   */
  resolvedRecords?: readonly ResolvedMmrCustomSubagentRecord[];
}

/** Registered custom subagent tool paired with its config record. */
export interface RegisteredMmrCustomSubagent {
  tool: ToolDefinition;
  record: MmrCustomSubagentRecord;
}

/**
 * Legacy external-harness roots scanned for *import candidates only*. These
 * are never auto-registered; ampi discovers them so the setup/import flow
 * can offer to port selected agents into a Pi-owned root + config record.
 */
export function getLegacyClaudeSubagentRoots(cwd: string, home = homedir()): readonly string[] {
  return [path.join(cwd, ".claude", "agents"), path.join(home, ".claude", "agents")];
}

/**
 * Count discoverable legacy Claude-style agent candidates. Used to drive the
 * one-time migration notice: ampi no longer auto-loads `.claude/agents`, so
 * when candidates exist but nothing is enabled in config we point the user at
 * setup/import.
 */
export function countLegacyClaudeSubagentCandidates(cwd: string, home = homedir()): number {
  try {
    return discoverMmrCustomSubagentsSync({ roots: getLegacyClaudeSubagentRoots(cwd, home) }).length;
  } catch {
    return 0;
  }
}

/**
 * Build an effective definition for a configured record by parsing its source
 * Markdown and overlaying the config record's authoritative `toolName`,
 * `model`, `thinkingLevel`, and `tools`. Config is the enablement boundary, so
 * its fields win over the Markdown frontmatter defaults.
 */
function definitionFromRecord(
  parsed: MmrCustomSubagentDefinition,
  record: MmrCustomSubagentRecord,
): MmrCustomSubagentDefinition {
  const toolPatterns = record.tools
    ? normalizeMmrCustomSubagentToolPatterns([...record.tools])
    : parsed.toolPatterns;
  return {
    ...parsed,
    toolName: record.toolName,
    model: record.model,
    modelDeclared: true,
    ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
    toolPatterns,
    toolsDeclared: record.tools !== undefined ? true : parsed.toolsDeclared,
  };
}

/** A subagent Markdown candidate discovered on disk (not yet enabled). */
export interface MmrCustomSubagentCandidate {
  definition: MmrCustomSubagentDefinition;
  /** Source kind for display: a Pi-owned root or a legacy external harness root. */
  sourceKind: "pi-global" | "pi-project" | "claude";
}

/**
 * Discover subagent Markdown candidates from the Pi-owned roots and the legacy
 * Claude roots. Candidates are inert until an enabled config record references
 * them; the setup/import flow uses this to list what the user can enable or
 * port.
 */
export function discoverMmrCustomSubagentCandidates(
  cwd: string,
  home = homedir(),
): MmrCustomSubagentCandidate[] {
  const roots = getPiOwnedSubagentRoots(cwd, home);
  const out: MmrCustomSubagentCandidate[] = [];
  const groups: { kind: MmrCustomSubagentCandidate["sourceKind"]; root: string }[] = [
    { kind: "pi-project", root: roots.project },
    { kind: "pi-global", root: roots.global },
    ...getLegacyClaudeSubagentRoots(cwd, home).map((root) => ({ kind: "claude" as const, root })),
  ];
  const seen = new Set<string>();
  for (const group of groups) {
    let definitions: MmrCustomSubagentDefinition[];
    try {
      definitions = discoverMmrCustomSubagentsSync({ roots: [group.root] });
    } catch {
      definitions = [];
    }
    for (const definition of definitions) {
      if (seen.has(definition.filePath)) continue;
      seen.add(definition.filePath);
      out.push({ definition, sourceKind: group.kind });
    }
  }
  return out;
}

/** Whether `target` is the same path as, or nested inside, `root`. */
function isInsideRoot(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Read and parse an enabled record's source Markdown with the same filesystem
 * hardening the discovery walker uses: open the final component with
 * `O_NOFOLLOW` (refuse a symlink swapped in for the source file), refuse a
 * symlinked Pi-owned root, bound the size from the same descriptor we read,
 * and verify the file's realpath stays inside the Pi-owned root. An enabled
 * record must never let a project point `.pi/subagents/foo.md` at a file
 * outside the Pi-owned root via a symlink.
 */
function parseRecordSourceFile(filePath: string, rootDir: string): MmrCustomSubagentDefinition | undefined {
  let markdown: string | undefined;
  let fd: number | undefined;
  try {
    const rootStat = fs.lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return undefined;
    fd = fs.openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES) return undefined;
    let canonicalRoot: string;
    let canonicalFile: string;
    try {
      canonicalRoot = fs.realpathSync(rootDir);
      canonicalFile = fs.realpathSync(filePath);
    } catch {
      return undefined;
    }
    if (!isInsideRoot(canonicalFile, canonicalRoot)) return undefined;
    markdown = fs.readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort descriptor cleanup
      }
    }
  }
  if (markdown === undefined) return undefined;
  try {
    // Records reference Pi-owned files the user explicitly enabled; accept
    // plain Markdown bodies without subagent frontmatter as well.
    return parseMmrCustomSubagentMarkdown({ filePath, markdown, allowMissingFrontmatter: true });
  } catch {
    return undefined;
  }
}

function toModelPreference(model: string): MmrModelPreference | undefined {
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed === "inherit") return undefined;
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providers: [trimmed.slice(0, slash)], model: trimmed.slice(slash + 1) };
  }
  return { model: trimmed };
}

function readCurrentModelPreference(ctx: unknown): MmrModelPreference | undefined {
  if (!isRecord(ctx)) return undefined;
  const model = ctx.model;
  if (!isRecord(model)) return undefined;
  const id = typeof model.id === "string" ? model.id : undefined;
  if (!id) return undefined;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  return provider ? { providers: [provider], model: id } : { model: id };
}

function preferencesForDefinition(definition: MmrCustomSubagentDefinition): readonly MmrModelPreference[] {
  const preference = toModelPreference(definition.model);
  return preference ? [preference] : [];
}

/**
 * Effective tool intent for a custom subagent: the author's declared
 * `tools:` list, or the standard default toolset when no `tools` key was
 * written at all. An explicitly empty list (declared with no entries) stays
 * empty so an author can deliberately run a prompt-only subagent.
 */
function effectiveCustomSubagentToolPatterns(definition: MmrCustomSubagentDefinition): readonly string[] {
  return definition.toolsDeclared ? definition.toolPatterns : MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS;
}

function createProfile(definition: MmrCustomSubagentDefinition): MmrSubagentProfile {
  return {
    name: definition.toolName,
    displayName: definition.name,
    modelPreferences: preferencesForDefinition(definition),
    tools: [...effectiveCustomSubagentToolPatterns(definition)],
    ...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
    denyTools: MMR_SUBAGENT_SHARED_DENY_TOOLS,
    promptRoute: "standalone",
    promptBuilder: definition.toolName,
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  };
}

function coerceParams(raw: unknown): { ok: true; value: CustomSubagentParams } | { ok: false; message: string } {
  if (!isRecord(raw) || typeof raw.task !== "string" || raw.task.trim().length === 0) {
    return { ok: false, message: "Custom subagent requires a non-empty task string." };
  }
  return { ok: true, value: { task: raw.task } };
}

function getRegisteredToolNames(pi: ExtensionAPI): string[] {
  return pi.getAllTools().map((tool) => tool.name).filter((name) => typeof name === "string" && name.length > 0);
}

function getParentAllowedRegisteredTools(pi: ExtensionAPI): string[] {
  const registered = new Set(getRegisteredToolNames(pi));
  const active = new Set(pi.getActiveTools().filter((name) => typeof name === "string" && name.length > 0));
  return [...active].filter((name) => registered.has(name));
}

function formatHumanList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Build the user-facing notice shown when a custom subagent relied on a
 * fallback for `model`, thinking/effort level, or `tools`. ampi lowers
 * friction by defaulting an omitted `tools:` key to the standard toolset
 * and inheriting the parent model/thinking level, but it surfaces this so
 * the author can pin the fields for predictable behavior. An explicitly
 * empty `tools` list is reported as "ran with no tools" (a deliberate
 * prompt-only subagent) rather than a default.
 *
 * Returns `undefined` when `model`, thinking level, and a non-empty tools
 * set were all resolved without a fallback.
 */
export function buildMmrCustomSubagentFallbackNotice(
  definition: MmrCustomSubagentDefinition,
  workerTools: readonly string[],
): string | undefined {
  const lines: string[] = [];
  const recommend: string[] = [];
  if (!definition.modelDeclared) {
    lines.push("No model selected — falling back to the parent model.");
    recommend.push("`model`");
  }
  if (definition.thinkingLevel === undefined) {
    lines.push("No effort/thinking level selected — falling back to the parent/default level.");
    recommend.push("`thinkingLevel`");
  }
  if (!definition.toolsDeclared) {
    lines.push("No tools selected — defaulting to the standard toolset (read, bash, edit, write, find, grep, web).");
    recommend.push("`tools`");
  } else if (workerTools.length === 0) {
    lines.push(
      "No tools available — the `tools` list is empty, so this subagent ran with no tools and answered from its prompt only (it could not read files, search, run commands, or edit).",
    );
    recommend.push("a non-empty `tools` list");
  }
  if (lines.length === 0) return undefined;
  const file = path.basename(definition.filePath);
  const body = lines.map((line) => `- ${line}`).join("\n");
  return `Note (${definition.name}):\n${body}\nRecommend setting ${formatHumanList(recommend)} in ${file} for predictable subagent behavior.`;
}

function buildFinalContent(
  result: MmrWorkerResult,
  definition: MmrCustomSubagentDefinition,
): string {
  // The fallback notice is intentionally NOT prepended here: it is a
  // user-facing advisory surfaced only via `details.fallbackNotice` and the
  // result renderer, so it never enters the model-consumed content.
  const status = classifyMmrWorkerOutcomeForProfile(result, getMmrSubagentProfile(definition.toolName));
  const text = result.truncatedFinalOutput || result.finalOutput;
  if (status === "success") {
    return text.trim().length > 0 ? text : `${definition.name}: completed with no output.`;
  }
  return `${definition.name}: worker failed (${status}).${result.errorMessage ? ` ${result.errorMessage}` : ""}${text ? `\n\n${text}` : ""}`;
}

function buildProgressDetails(
  snapshot: MmrWorkerProgressSnapshot,
  definition: MmrCustomSubagentDefinition,
  ctx: { cwd: string; workerTools: readonly string[]; model?: string; contextWindow?: number; prompt: string },
): CustomSubagentDetails {
  const fallbackNotice = buildMmrCustomSubagentFallbackNotice(definition, ctx.workerTools);
  return {
    worker: `ampi-custom-subagents.${definition.toolName}`,
    toolName: definition.toolName,
    definitionName: definition.name,
    filePath: definition.filePath,
    prompt: ctx.prompt,
    ...(fallbackNotice ? { fallbackNotice } : {}),
    ...buildSpawnedProgressDetailsBase({
      snapshot,
      cwd: ctx.cwd,
      workerTools: ctx.workerTools,
      resolvedModel: ctx.model,
      contextWindow: ctx.contextWindow,
    }),
  };
}

function buildFinalDetails(
  result: MmrWorkerResult,
  definition: MmrCustomSubagentDefinition,
  ctx: { cwd: string; workerTools: readonly string[]; model?: string; contextWindow?: number; prompt: string },
): CustomSubagentDetails {
  const fallbackNotice = buildMmrCustomSubagentFallbackNotice(definition, ctx.workerTools);
  return {
    worker: `ampi-custom-subagents.${definition.toolName}`,
    status: classifyMmrWorkerOutcomeForProfile(result, getMmrSubagentProfile(definition.toolName)),
    toolName: definition.toolName,
    definitionName: definition.name,
    filePath: definition.filePath,
    prompt: ctx.prompt,
    ...(fallbackNotice ? { fallbackNotice } : {}),
    ...buildSpawnedFinalDetailsBase({
      result,
      cwd: ctx.cwd,
      workerTools: ctx.workerTools,
      resolvedModel: ctx.model,
      contextWindow: ctx.contextWindow,
    }),
  };
}

/** Shared 80-char display clip for board-row descriptions (mirrors the background member normalization). */
function clipCustomSubagentDescription(text: string): string {
  const summary = text.replace(/\s+/g, " ").trim();
  return summary.length > 80 ? `${summary.slice(0, 77)}…` : summary;
}

/** Zero-usage details for pre-spawn failures (params validation, activation). */
function preSpawnFailureDetails(
  definition: MmrCustomSubagentDefinition,
  args: {
    status: MmrWorkerOutcomeStatus | "validation-error" | "activation-error" | "worker-error";
    errorMessage: string;
    prompt: string;
    cwd: string;
    workerTools: readonly string[];
  },
): CustomSubagentDetails {
  return {
    worker: `ampi-custom-subagents.${definition.toolName}`,
    toolName: definition.toolName,
    definitionName: definition.name,
    filePath: definition.filePath,
    prompt: args.prompt,
    status: args.status as MmrWorkerOutcomeStatus,
    exitCode: null,
    signal: null,
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    stderr: "",
    command: "",
    args: [],
    cwd: args.cwd,
    workerTools: args.workerTools,
    trail: [],
    errorMessage: args.errorMessage,
  };
}

/**
 * Per-call model-preference override + tool-set resolution captured on the
 * invocation object so the spec's later builders (runner options) can read it
 * without racy per-spec state. `customModelPreferencesOverride` carries the
 * `model: inherit` parent-model preference forwarded to the child runner.
 */
type CustomSubagentInvocation = MmrSubagentInvocation & {
  customModelPreferencesOverride?: readonly MmrModelPreference[];
};

/**
 * Build the declarative worker-tool spec for a custom Markdown subagent.
 * The execution skeleton is the shared worker-tool factory (via the core
 * worker-host seam); this spec pins the pre-factory behavior verbatim:
 *
 *  - structured params failure (`worker-error` details, never a host throw);
 *  - fail-closed activation when a model registry is present and the
 *    resolver cannot produce a route (`activation-error` details);
 *  - a context WITHOUT a model registry degrades to "no explicit model,
 *    active∩registered∩declared tools" (the pre-seam contract), expressed
 *    as a synthetic ok invocation so the run still mirrors `--tools`;
 *  - `model: inherit` resolves the parent model and forwards it as a
 *    session-scoped preference override to the child;
 *  - `isolatedContext` maps to `systemPromptDelivery: "replace"`, else append;
 *  - NO shared model-fallback wrapper (`modelFallback: "disabled"`, pinned).
 */
function createCustomSubagentSpec(
  pi: ExtensionAPI,
  definition: MmrCustomSubagentDefinition,
): MmrWorkerToolSpec<CustomSubagentParams, CustomSubagentDetails> {
  const description = [
    definition.description,
    "",
    `Custom Markdown subagent loaded from ${path.basename(definition.filePath)}.`,
    "Provide a specific task for the worker. The worker runs with the Markdown body as its system prompt and only the requested tools that are registered and active in the parent session.",
  ].join("\n");
  const patterns = effectiveCustomSubagentToolPatterns(definition);
  const detailsCtx = (runCtx: MmrWorkerToolRunContext<CustomSubagentParams, void>) => ({
    cwd: runCtx.cwd,
    workerTools: runCtx.workerTools,
    ...(runCtx.resolvedModel !== undefined ? { model: runCtx.resolvedModel } : {}),
    ...(runCtx.contextWindow !== undefined ? { contextWindow: runCtx.contextWindow } : {}),
    prompt: runCtx.params.task,
  });
  return {
    toolName: definition.toolName,
    profileName: definition.toolName,
    description,
    promptSnippet: definition.description,
    promptGuidelines: [
      `Use ${definition.toolName} when the task matches this custom subagent: ${definition.description}`,
      "Provide a concrete task, relevant files or evidence, constraints, and the expected output shape.",
      "Do not use this custom subagent when a direct tool call or built-in subagent is a better fit.",
    ],
    parameters: CUSTOM_SUBAGENT_PARAMETERS_SCHEMA,
    ...(patterns.some((tool) => ["bash", "edit", "write", "apply_patch"].includes(tool))
      ? { executionMode: "sequential" as const }
      : {}),
    modelFallback: "disabled",
    progressPlaceholder: `${definition.name}: worker running…`,
    coerceParams(raw) {
      const parsed = coerceParams(raw);
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.value;
    },
    paramsFailure(message, _raw, cwd) {
      return {
        content: [{ type: "text", text: `${definition.name}: ${message}` }],
        details: preSpawnFailureDetails(definition, {
          status: "worker-error",
          errorMessage: message,
          prompt: "",
          cwd,
          workerTools: [],
        }),
      };
    },
    resolveInvocation(input, _params): MmrSubagentInvocation {
      const ctx = input.ctx;
      const registry = resolveCtxMmrModelRegistry(ctx);
      const parentMode = getMmrModeStateSnapshot()?.mode;
      const inheritOverride = definition.model === "inherit"
        ? [readCurrentModelPreference(ctx)].filter((entry): entry is MmrModelPreference => Boolean(entry))
        : undefined;
      const profile = inheritOverride && inheritOverride.length > 0
        ? { ...createProfile(definition), modelPreferences: inheritOverride }
        : createProfile(definition);
      const registeredTools = getParentAllowedRegisteredTools(pi);
      if (!registry) {
        // No model registry in the context: degrade to "no explicit model"
        // while keeping the active∩registered∩declared tool ceiling mirrored
        // to the child (the pre-seam custom-subagent contract).
        const workerTools = registeredTools.filter((tool) => patterns.includes(tool));
        const synthetic: Partial<CustomSubagentInvocation> = {
          ok: true,
          workerTools,
          ...(inheritOverride && inheritOverride.length > 0
            ? { customModelPreferencesOverride: inheritOverride }
            : {}),
        };
        return synthetic as CustomSubagentInvocation;
      }
      const invocation = resolveMmrSubagentInvocation({
        profile,
        registry,
        registeredTools,
        parentActiveTools: pi.getActiveTools(),
        ...(parentMode ? { parentMode } : {}),
      });
      if (inheritOverride && inheritOverride.length > 0) {
        return { ...invocation, customModelPreferencesOverride: inheritOverride } as CustomSubagentInvocation;
      }
      return invocation;
    },
    resolutionFailure: "fail-closed",
    resolutionFailureResult(invocation, params, cwd) {
      return {
        content: [{ type: "text", text: `${definition.name}: ${invocation.message}` }],
        details: preSpawnFailureDetails(definition, {
          status: "activation-error",
          errorMessage: invocation.message,
          prompt: params.task,
          cwd,
          workerTools: invocation.workerTools,
        }),
      };
    },
    mirrorWorkerTools: true,
    detailsWorkerTools: "invocation",
    workerToolsConstant: patterns,
    progressModelBinding: "initial",
    describeRun(params) {
      return {
        description: `${definition.toolName}: ${clipCustomSubagentDescription(params.task) || "custom run"}`,
        displayPrompt: params.task,
      };
    },
    buildUserPrompt(params) {
      return params.task;
    },
    assembleSystemPrompt() {
      return definition.systemPrompt;
    },
    resolveContextWindow(ctx, model) {
      return resolveMmrWorkerModelContextWindowFromCtx(ctx, model);
    },
    extraRunnerOptions(runCtx) {
      const override = (runCtx.invocation as CustomSubagentInvocation | undefined)?.customModelPreferencesOverride;
      return {
        systemPromptDelivery: definition.isolatedContext ? "replace" : "append",
        ...(override && override.length > 0 ? { modelPreferencesOverride: override } : {}),
      };
    },
    candidatePreferences() {
      // No shared fallback for custom workers (modelFallback: "disabled").
      return [];
    },
    buildProgressDetails(snapshot, runCtx) {
      return buildProgressDetails(snapshot, definition, detailsCtx(runCtx));
    },
    buildFinalDetails(result, runCtx) {
      return buildFinalDetails(result, definition, detailsCtx(runCtx));
    },
    buildFinalContent(result) {
      return buildFinalContent(result, definition);
    },
  };
}

export function registerMmrCustomSubagentDefinition(
  pi: ExtensionAPI,
  definition: MmrCustomSubagentDefinition,
  deps: CustomSubagentToolDeps = {},
): ToolDefinition {
  const unsafeTool = definition.toolPatterns.find(isUnsafeMmrCustomSubagentToolPattern);
  if (unsafeTool) {
    throw new Error(`custom subagent "${definition.name}" requests denied tool "${unsafeTool}"`);
  }
  registerMmrSubagentProfile(createProfile(definition));
  registerMmrSubagentPromptBuilder(definition.toolName, () => definition.systemPrompt);
  // Register through the core worker-host seam: the shared worker-tool
  // factory builds the blocking tool AND the background descriptor from one
  // spec, so blocking sa__* runs register in the async-task registry
  // (board/widget visible) and background runs share the same preparation
  // path — no bespoke execute, no tool-execute adapter.
  const registered = registerMmrWorkerBinding({
    spec: createCustomSubagentSpec(pi, definition),
    exposure: ["tool", "background"],
    contractPreset: "strict-delegated",
    paramsHint: "{task}",
    promptParamKey: "task",
    boardWorkerTools: effectiveCustomSubagentToolPatterns(definition),
    modelFallback: "disabled",
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    ...(deps.outputByteLimit !== undefined ? { outputByteLimit: deps.outputByteLimit } : {}),
  });
  registerAmpiOwnedTool(definition.toolName);
  pi.registerTool(registered.tool);
  return registered.tool;
}

/**
 * Register the enabled, in-scope custom Markdown subagents for the active
 * project. Config is the enablement boundary: only agents with an enabled
 * `mmrSubagents.custom.agents` record (global or project) and a valid,
 * in-scope source file become registered `sa__*` tools. A Markdown file merely
 * present in a Pi-owned root is a discovered candidate, not a registered tool,
 * until setup/import writes an enabled record for it.
 *
 * Per-mode exposure is handled separately: a mode-extra-tool provider is
 * registered so each `sa__*` tool only enters a locked mode's active tool set
 * when that mode is listed in the record's `modes` scope.
 */
export function registerMmrCustomSubagentTools(
  pi: ExtensionAPI,
  options: RegisterMmrCustomSubagentToolsOptions = {},
): ToolDefinition[] {
  // Custom subagents execute through the core worker-host seam; without a
  // registered host (ampi-workers not active) no sa__* tool can run, so
  // registration fails closed for the whole set — loud but non-fatal, the
  // rest of the session keeps working.
  if (!getMmrWorkerHost()) {
    // eslint-disable-next-line no-console
    console.warn(
      "ampi-custom-subagents: no worker host is registered (ampi-workers is not active); custom sa__* subagents were not registered.",
    );
    return [];
  }
  const cwd = options.cwd ?? process.cwd();
  const resolved = options.resolvedRecords
    ?? resolveEnabledMmrCustomSubagents({ cwd, ...(options.homeDir ? { homeDir: options.homeDir } : {}) }).resolved;

  const registered: RegisteredMmrCustomSubagent[] = [];
  const seen = new Set<string>();
  for (const { record, filePath, rootDir } of resolved) {
    if (seen.has(record.toolName)) continue;
    const parsed = parseRecordSourceFile(filePath, rootDir);
    if (!parsed) continue;
    const definition = definitionFromRecord(parsed, record);
    if (!definition.toolName.startsWith(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX)) continue;
    if (definition.toolPatterns.some(isUnsafeMmrCustomSubagentToolPattern)) continue;
    seen.add(record.toolName);
    const tool = registerMmrCustomSubagentDefinition(pi, definition, options);
    registered.push({ tool, record });
  }

  registerCustomSubagentModeExtraProvider(cwd, registered);
  return registered.map((entry) => entry.tool);
}

/**
 * Register a mode-extra-tool provider so each enabled custom subagent only
 * appears in the locked modes its config record allows. The provider captures
 * the registration cwd and resolved records; it returns a record's tool name
 * only when the queried mode is in scope and the queried cwd matches the
 * project the records were resolved for.
 */
function registerCustomSubagentModeExtraProvider(
  cwd: string,
  registered: readonly RegisteredMmrCustomSubagent[],
): void {
  const resolvedCwd = path.resolve(cwd);
  const entries = registered.map((entry) => ({ toolName: entry.record.toolName, modes: entry.record.modes }));
  registerMmrModeExtraToolProvider({
    name: "ampi-custom-subagents",
    getExtraTools({ modeKey, cwd: queryCwd }) {
      if (path.resolve(queryCwd) !== resolvedCwd) return [];
      const result: string[] = [];
      for (const entry of entries) {
        const allowed = entry.modes === "allLocked" || entry.modes.includes(modeKey as MmrLockedModeKey);
        if (allowed) result.push(entry.toolName);
      }
      return result;
    },
  });
}
