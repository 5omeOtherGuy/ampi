import {
  buildBuiltinToolGuidance,
  extractActiveBuiltinToolNames,
} from "./builtin-tool-guidance.js";
import { SHARED_CODING_GUIDANCE, SHARED_TOOL_GUIDANCE } from "./prompt-modules.js";
import { MMR_MODE_PROMPT_TEMPLATES } from "./prompt-templates.js";
import type {
  MmrActiveToolManifestEntry,
  MmrModeKey,
  MmrModeState,
  MmrPromptAssemblyResult,
  MmrPromptBlock,
  MmrPromptPassthroughReason,
} from "./types.js";

/**
 * Public mmr-core constants reused by the splice. Kept here so other modules
 * (debug renderer, tests) can reference them without re-deriving from
 * prompt.ts internals.
 */
export const MMR_IDENTITY_LINE =
  "You are an expert coding assistant operating inside pi, a coding agent harness.";

export const MMR_TOOL_USE_HEADING = "## Tool use";

export const MMR_TOOL_USE_POSTURE_LINE =
  "Use context first; reach for a tool only when it would change your answer. Run independent read-only calls in parallel; never parallelize edits to the same file. Avoid repeated reads of the same content.";

export const MMR_ADDITIONAL_TOOLS_LINE =
  "In addition to the tools above, you may have access to other custom tools depending on the project.";

export const MMR_RESPONSE_STYLE_HEADING = "## Response style";

/** Structural anchors for Pi's auto-emitted sections. See prompt.ts notes. */
const TOOLS_SECTION_ANCHOR = "\n\nAvailable tools:\n";
const GUIDELINES_SECTION_ANCHOR = "\n\nGuidelines:\n";
const PI_DOCS_SECTION_ANCHOR = "\n\nPi documentation (";
const DATE_TAIL_ANCHOR = "\nCurrent date:";

function findHeaderStart(prompt: string, anchor: string, fromIdx: number): number {
  const idx = prompt.indexOf(anchor, fromIdx);
  return idx === -1 ? -1 : idx + 2;
}

const MMR_TAIL_SEPARATOR = "\n\n";

/**
 * Exact-text reconstruction of the MMR-owned tail blocks (shared tool
 * guidance, shared coding guidance, mode posture) for every known mode
 * template. Used to detect and strip a previously-injected MMR tail when
 * `assembleActiveSurface` re-runs on an already-assembled prompt, so the
 * blocks are replaced rather than duplicated. Mode-independent: the parent
 * prompt fed into a re-assembly may have been produced for a different mode
 * (e.g. a `deep` parent aliased to a `smart` Task base).
 */
const PREVIOUS_MMR_TAILS: readonly string[] = Object.values(MMR_MODE_PROMPT_TEMPLATES).map(
  (previousTemplate) =>
    `${SHARED_TOOL_GUIDANCE}\n\n${SHARED_CODING_GUIDANCE}\n\n${previousTemplate.postureSections}\n\n${MMR_RESPONSE_STYLE_HEADING}\n\n${previousTemplate.closingLine}`,
);

/**
 * Locate the end of a previously-injected MMR tail that sits immediately
 * after Pi's docs block. Returns the byte offset just past the prior mode's
 * closing line (the start of Pi's preserved tail), or `undefined` when the
 * base prompt has not already been MMR-assembled. Matches by exact tail
 * text so a preserved Pi tail that merely contains a heading like
 * `## Response style` cannot trigger a false strip.
 */
function findPreviousMmrTailEnd(base: string, docsEnd: number): number | undefined {
  if (!base.startsWith(MMR_TAIL_SEPARATOR, docsEnd)) return undefined;
  const tailStart = docsEnd + MMR_TAIL_SEPARATOR.length;
  for (const previousTail of PREVIOUS_MMR_TAILS) {
    if (!base.startsWith(previousTail, tailStart)) continue;
    const end = tailStart + previousTail.length;
    // Pi's preserved tail is either empty or starts at a newline boundary
    // (`\n\n...` normal tail, or `\nCurrent date:` minimal Pi tail).
    if (end === base.length || base[end] === "\n") return end;
  }
  return undefined;
}

export interface AssembleActiveSurfaceInput {
  state: MmrModeState;
  /** Pi's current chained system prompt for this turn. Read-only input. */
  baseSystemPrompt: string;
  /**
   * The caller-resolved active tool manifest for this turn. Must contain only
   * currently-active tools; deferred/planned/gated/disabled entries must not
   * appear here. Passed through unchanged into the result.
   */
  activeToolManifest: MmrActiveToolManifestEntry[];
  /**
   * Built-in tool guidance source. When provided, the `## Built-in tool
   * guidance` block follows these tool names (the resolved callable/active
   * set) instead of the names parsed from Pi's rendered `Available tools:`
   * block, so guidance covers a tool the agent can call even when Pi did
   * not give it a one-line snippet (snippet-gated tools are omitted from the
   * rendered block but remain callable). `buildBuiltinToolGuidance` filters
   * this list to the curated built-ins, so passing the full active set is
   * safe. An empty array suppresses the block; when omitted, the block falls
   * back to parsing the rendered tools text (unchanged behavior).
   */
  activeToolNames?: readonly string[];
  /** Optional provider/model identifiers forwarded to the result. */
  provider?: string;
  model?: string;
}

function passthroughResult(
  input: AssembleActiveSurfaceInput,
  passthroughReason: MmrPromptPassthroughReason,
): MmrPromptAssemblyResult {
  return {
    mode: input.state.mode,
    provider: input.provider,
    model: input.model,
    blocks: [
      {
        id: "preserved-tail:passthrough",
        kind: "preserved-tail",
        text: input.baseSystemPrompt,
        source: "pi",
      },
    ],
    systemPrompt: input.baseSystemPrompt,
    activeToolManifest: input.activeToolManifest,
    passthroughReason,
  };
}

type PromptedMmrModeKey = Exclude<MmrModeKey, "free">;

function isPromptedMode(mode: string): mode is PromptedMmrModeKey {
  return mode in MMR_MODE_PROMPT_TEMPLATES;
}

/**
 * Build the ordered prompt-block surface for the current MMR mode. The
 * splice surgically replaces Pi's auto-rendered head (identity line through
 * the end of the `Pi documentation` block) with a labeled sequence of
 * blocks; flattening `blocks[].text` concatenated reproduces the
 * `systemPrompt` string byte-for-byte.
 *
 * Policy: Pi-authored blocks (`Available tools:`, `Guidelines:`,
 * `Pi documentation`) are passed through verbatim. The free mode and any
 * unrecognized base layout fall back to a single passthrough block.
 */
export function assembleActiveSurface(
  input: AssembleActiveSurfaceInput,
): MmrPromptAssemblyResult {
  const mode = input.state.mode;
  if (!isPromptedMode(mode)) return passthroughResult(input, "not-prompted-mode");

  const base = input.baseSystemPrompt;
  const introStart = base.indexOf(MMR_IDENTITY_LINE);
  if (introStart === -1) return passthroughResult(input, "identity-anchor-missing");

  const toolsStart = findHeaderStart(base, TOOLS_SECTION_ANCHOR, introStart);
  const guidelinesStart = findHeaderStart(base, GUIDELINES_SECTION_ANCHOR, introStart);
  const piDocsStart = findHeaderStart(base, PI_DOCS_SECTION_ANCHOR, introStart);

  if (toolsStart === -1 || guidelinesStart === -1 || piDocsStart === -1) {
    return passthroughResult(input, "section-anchor-missing");
  }

  if (
    !(introStart < toolsStart && toolsStart < guidelinesStart && guidelinesStart < piDocsStart)
  ) {
    return passthroughResult(input, "section-order-invalid");
  }

  const toolsEnd = base.indexOf("\n\n", toolsStart);
  const guidelinesEnd = base.indexOf("\n\n", guidelinesStart);
  if (toolsEnd === -1 || guidelinesEnd === -1) return passthroughResult(input, "section-boundary-missing");

  const docsBlankIdx = base.indexOf("\n\n", piDocsStart);
  const docsDateIdx = base.indexOf(DATE_TAIL_ANCHOR, piDocsStart);
  const docsEndCandidates = [docsBlankIdx, docsDateIdx].filter((idx) => idx !== -1);
  const docsEnd = docsEndCandidates.length === 0 ? base.length : Math.min(...docsEndCandidates);

  // `before_agent_start` handlers are chained. Mode-derived Task workers can
  // receive the parent prompt after mmr-core already assembled it, then call
  // this function again to rebuild the active-tools block for the child. In
  // that case, strip the previous MMR-owned shared/mode blocks and preserve
  // only Pi's docs block plus the original tail; otherwise repeated assembly
  // duplicates every long MMR instruction.
  const headEnd = findPreviousMmrTailEnd(base, docsEnd) ?? docsEnd;

  // Preserve Pi's whole tools block — the `Available tools:` list AND Pi's
  // "In addition to the tools above..." interstitial sentence — byte-for-byte
  // (up to the `Guidelines:` header). Reconstructing the interstitial from a
  // local constant would silently emit stale text (and bypass drift detection)
  // if Pi ever changes that sentence.
  const toolsBlockText = base.slice(toolsStart, guidelinesStart);
  const guidelinesContent = base.slice(guidelinesStart, guidelinesEnd);
  const piDocumentationContent = base.slice(piDocsStart, docsEnd);

  const template = MMR_MODE_PROMPT_TEMPLATES[mode];
  const before = base.slice(0, introStart);
  const after = base.slice(headEnd);

  // Each block's text includes its own trailing separators so that
  // concatenating all blocks reproduces the systemPrompt byte-for-byte.
  const identityBlock: MmrPromptBlock = {
    id: `identity:${mode}`,
    kind: "identity",
    text: `${before}${MMR_IDENTITY_LINE} <mmr_mode name="${template.tag}">${template.intro}</mmr_mode>\n\n`,
    source: "mmr-core",
  };

  const toolLeadInBlock: MmrPromptBlock = {
    id: "tool-lead-in",
    kind: "tool-lead-in",
    text: `${MMR_TOOL_USE_HEADING}\n\n${MMR_TOOL_USE_POSTURE_LINE}\n\n`,
    source: "mmr-core",
  };

  const activeToolsBlock: MmrPromptBlock = {
    id: "active-tools",
    kind: "active-tools",
    text: toolsBlockText,
    source: "pi",
  };

  const activeGuidelinesBlock: MmrPromptBlock = {
    id: "active-guidelines",
    kind: "active-guidelines",
    text: `${guidelinesContent}\n\n`,
    source: "pi",
  };

  const builtinToolGuidanceText = buildBuiltinToolGuidance(
    input.activeToolNames ?? extractActiveBuiltinToolNames(toolsBlockText),
  );
  const builtinToolGuidanceBlock: MmrPromptBlock | null = builtinToolGuidanceText
    ? {
        id: "builtin-tool-guidance",
        kind: "builtin-tool-guidance",
        text: `${builtinToolGuidanceText}\n\n`,
        source: "mmr-core",
      }
    : null;

  const piDocsBlock: MmrPromptBlock = {
    id: "pi-docs",
    kind: "pi-docs",
    text: `${piDocumentationContent}\n\n`,
    source: "pi",
  };

  const sharedToolGuidanceBlock: MmrPromptBlock = {
    id: "shared-tool-guidance",
    kind: "shared-tool-guidance",
    text: `${SHARED_TOOL_GUIDANCE}\n\n`,
    source: "mmr-core",
  };

  const sharedCodingGuidanceBlock: MmrPromptBlock = {
    id: "shared-coding-guidance",
    kind: "shared-coding-guidance",
    text: `${SHARED_CODING_GUIDANCE}\n\n`,
    source: "mmr-core",
  };

  const modePostureBlock: MmrPromptBlock = {
    id: `mode-posture:${mode}`,
    kind: "mode-posture",
    text: `${template.postureSections}\n\n${MMR_RESPONSE_STYLE_HEADING}\n\n${template.closingLine}`,
    source: "mmr-core",
  };

  const preservedTailBlock: MmrPromptBlock = {
    id: "preserved-tail",
    kind: "preserved-tail",
    text: after,
    source: "pi",
  };

  const blocks: MmrPromptBlock[] = [
    identityBlock,
    toolLeadInBlock,
    activeToolsBlock,
    activeGuidelinesBlock,
    ...(builtinToolGuidanceBlock ? [builtinToolGuidanceBlock] : []),
    piDocsBlock,
    sharedToolGuidanceBlock,
    sharedCodingGuidanceBlock,
    modePostureBlock,
    preservedTailBlock,
  ];

  const systemPrompt = blocks.map((b) => b.text).join("");

  return {
    mode,
    provider: input.provider,
    model: input.model,
    blocks,
    systemPrompt,
    activeToolManifest: input.activeToolManifest,
  };
}
