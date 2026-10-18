import { homedir } from "node:os";
import {
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  isReadToolResult,
  loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { loadMmrCoreSettings } from "./settings.js";
import {
  AMPI_SUBTREE_GUIDANCE_ENTRY,
  coveredMmrSubtreeGuidanceEntry,
  formatMmrSubtreeGuidanceBlock,
  type MmrGuidanceFileReader,
  rebuildMmrSubtreeGuidanceCoverage,
  resetMmrSubtreeGuidanceEntry,
  resolveMmrReadToolPath,
  selectMmrSubtreeGuidance,
} from "./subtree-guidance.js";
import { extractExplicitWorkerCliFlags } from "./worker-cli-flags.js";

export interface MmrSubtreeGuidanceHookOptions {
  /** Pi's arguments, read for `--no-context-files`. Defaults to `process.argv.slice(2)`. */
  argv?: readonly string[];
  /** Pi's own context-file discovery for `cwd`. Defaults to `loadProjectContextFiles` with Pi's agent directory. */
  discoverContextFiles?: (cwd: string) => readonly unknown[];
  /** Home directory for the settings files and `~` in read paths. Defaults to `os.homedir()`. */
  homeDirectory?: string;
  /** Reads guidance files; see `selectMmrSubtreeGuidance`. */
  readFile?: MmrGuidanceFileReader;
}

export interface MmrSubtreeGuidanceHooks {
  /**
   * Note the context files Pi passed for this prompt. ampi-core's own
   * `before_agent_start` hook calls it, so core registers that event once.
   */
  observeAgentStart(event: Pick<BeforeAgentStartEvent, "systemPromptOptions">, ctx: Pick<ExtensionContext, "cwd">): void;
}

/**
 * Register the hooks that add subfolder guidance to Pi's `read` results (see
 * `subtree-guidance.ts`). The covered directories live in memory and in
 * custom session entries, so the set follows the current session branch.
 */
export function registerMmrSubtreeGuidanceHooks(
  pi: ExtensionAPI,
  options: MmrSubtreeGuidanceHookOptions = {},
): MmrSubtreeGuidanceHooks {
  const homeDirectory = options.homeDirectory ?? homedir();
  const discoverContextFiles =
    options.discoverContextFiles ?? ((cwd: string) => loadProjectContextFiles({ cwd, agentDir: getAgentDir() }));
  // Pi gives extensions no value for `--no-context-files`; runs that Pi starts
  // from a command line (worker children included) carry it on argv.
  const noContextFilesFlag = extractExplicitWorkerCliFlags(options.argv ?? process.argv.slice(2)).noContextFiles === true;
  let enabled = true;
  // Set when Pi passed no context files although its own discovery finds
  // some: context files are off for this run, however it was started.
  let contextFilesWithheld = false;
  let covered = new Set<string>();

  const rebuild = (ctx: ExtensionContext): void => {
    covered = rebuildMmrSubtreeGuidanceCoverage(ctx.sessionManager.getBranch());
  };

  pi.on("session_start", async (_event, ctx) => {
    enabled = loadMmrCoreSettings(ctx.cwd, homeDirectory).settings.subtreeGuidance !== false;
    rebuild(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    rebuild(ctx);
  });

  pi.on("session_compact", async () => {
    // The results that carried the guidance may be summarised away now.
    if (covered.size === 0) return;
    covered = new Set();
    pi.appendEntry(AMPI_SUBTREE_GUIDANCE_ENTRY, resetMmrSubtreeGuidanceEntry());
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || noContextFilesFlag || contextFilesWithheld) return;
    // A nested read (from a codemode script) goes back to the calling tool,
    // which decides what the model sees.
    if (!isReadToolResult(event) || event.isError || event.parentToolCallId !== undefined) return;
    if (typeof event.input.path !== "string") return;

    const selection = selectMmrSubtreeGuidance({
      filePath: resolveMmrReadToolPath(event.input.path, ctx.cwd, homeDirectory),
      cwd: ctx.cwd,
      covered,
      readFile: options.readFile,
    });
    if (selection.covered.length > 0) {
      for (const directory of selection.covered) covered.add(directory);
      pi.appendEntry(AMPI_SUBTREE_GUIDANCE_ENTRY, coveredMmrSubtreeGuidanceEntry(selection.covered));
    }
    if (selection.files.length === 0) return;

    const content = [
      ...event.content,
      ...selection.files.map((file) => ({ type: "text" as const, text: formatMmrSubtreeGuidanceBlock(file, ctx.cwd) })),
    ];
    // Pi drops structured content that is not returned with new content, and
    // the read tool declares an output schema. `details` stays the tool's own.
    return event.structuredContent === undefined ? { content } : { content, structuredContent: event.structuredContent };
  });

  return {
    observeAgentStart(event, ctx) {
      const contextFiles = event.systemPromptOptions?.contextFiles;
      if (!Array.isArray(contextFiles)) return;
      contextFilesWithheld = contextFiles.length === 0 && discoverContextFiles(ctx.cwd).length > 0;
    },
  };
}
