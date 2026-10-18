import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveMmrPackageRoot } from "../../ampi-core/changelog.js";
import {
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  registerMmrCommand,
  unregisterMmrCommand,
} from "../../ampi-core/command-registry.js";
import { MMR_MODE_KEYS } from "../../ampi-core/modes.js";
import { getMmrModeState } from "../../ampi-core/runtime.js";
import { canMmrSubmitEditorText, hasMmrEditorAction, runMmrEditorAction, submitMmrEditorText } from "../pi-compat/editor.js";
import { getMmrTranscriptScroller } from "../pi-compat/scroll.js";
import { MMR_PI_BUILTIN_SLASH_COMMANDS } from "../pi-compat/slash-commands.js";

/** Commands `ampi-tui` registers in ampi-core's command registry. */

export interface MmrTuiCommandHost {
  /** The TUI handle, once Pi has handed one to a component factory. */
  getTui(): TUI | undefined;
  /** Pi's extension API: slash commands and settings. */
  readonly pi: Pick<ExtensionAPI, "getCommands" | "getSettings" | "sendUserMessage">;
  /** Open the command palette. */
  openPalette(ctx: ExtensionContext): void;
  /** Called when `thread.interrupt` stops the running turn. */
  onInterrupt?(): void;
  /** Open or close the shortcuts help in the prompt box. */
  toggleHelp?(): void;
}

/** Commands that open the palette; the palette does not list them. */
export const MMR_PALETTE_COMMAND_IDS: ReadonlySet<string> = new Set(["ampi.palette", "prompt.openPalette"]);

const AVAILABLE: MmrCommandAvailability = { state: "available" };
const EXTERNAL_EDITOR_ACTION = "app.editor.external";
const THINKING_TOGGLE_ACTION = "app.thinking.toggle";
const PROMPT_HAS_TEXT: MmrCommandAvailability = { state: "unavailable", reason: "the prompt has text" };
const CORE_MISSING: MmrCommandAvailability = { state: "unavailable", reason: "ampi-core is not loaded" };

/** ampi-core slash commands the ampi rows run; the `pi` category leaves them out. */
const CORE_SLASH = { status: "ampi-status", changelog: "ampi-changelog", config: "ampi-config", mode: "mode" } as const;
const CORE_SLASH_NAMES: ReadonlySet<string> = new Set(Object.values(CORE_SLASH));

function readAmpiVersion(): string | undefined {
  const root = resolveMmrPackageRoot();
  if (!root) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function scrollAvailability(host: MmrTuiCommandHost, ctx: ExtensionContext): MmrCommandAvailability {
  if (!getMmrTranscriptScroller(host.getTui())) {
    return { state: "unavailable", reason: "the transcript scrolls only in Pi's fullscreen mode" };
  }
  // Home and End keep moving the cursor while the prompt has text.
  if (ctx.ui.getEditorText().length > 0) return { state: "unavailable", reason: "the prompt has text" };
  return AVAILABLE;
}

function hasSlashCommand(host: MmrTuiCommandHost, name: string): boolean {
  try {
    return host.pi.getCommands().some((command) => command.name === name);
  } catch {
    return false;
  }
}

/**
 * A command that runs an ampi-core slash command through Pi's command path,
 * so it gets the same command context as typing it. Unavailable when the
 * slash command is not registered, because Pi would otherwise send the text
 * to the model as a prompt.
 */
function coreSlashCommand(
  host: MmrTuiCommandHost,
  slash: string,
  definition: Omit<MmrCommandDefinition, "run" | "availability">,
  available: () => MmrCommandAvailability = () => AVAILABLE,
): MmrCommandDefinition {
  const name = slash.split(" ")[0];
  return {
    ...definition,
    availability: () => (hasSlashCommand(host, name) ? available() : CORE_MISSING),
    run: () => host.pi.sendUserMessage(`/${slash}`, { expandPromptTemplates: true }),
  };
}

/**
 * Pi's thinking blocks are hidden when `hideThinkingBlock` is set; Pi's
 * toggle saves the new value to its global settings. A project settings file
 * that sets `hideThinkingBlock` wins over that saved value, so there the
 * reading stays fixed and Alt+T can leave thinking out of step with the tools.
 */
function thinkingHidden(host: MmrTuiCommandHost): boolean {
  try {
    return host.pi.getSettings().hideThinkingBlock === true;
  } catch {
    return false;
  }
}

export function createMmrTuiCommands(host: MmrTuiCommandHost): MmrCommandDefinition[] {
  return [
    {
      id: "ampi.palette",
      noun: "ampi",
      verb: "open command palette",
      description: "Open the command palette",
      defaultKey: "ctrl+o",
      run: (ctx) => host.openPalette(ctx),
    },
    {
      id: "prompt.openPalette",
      noun: "prompt",
      verb: "open command palette",
      description: "Open the command palette when / is typed into an empty prompt",
      defaultKey: "/",
      // With text in the prompt, / is typed as usual.
      availability: (ctx) => (ctx.ui.getEditorText().length > 0 ? PROMPT_HAS_TEXT : AVAILABLE),
      run: (ctx) => host.openPalette(ctx),
    },
    {
      id: "thread.interrupt",
      noun: "thread",
      verb: "interrupt",
      description: "Stop the running turn",
      defaultKey: "esc esc",
      availability: (ctx) => (ctx.isIdle() ? { state: "unavailable", reason: "nothing is running" } : AVAILABLE),
      run: (ctx) => {
        host.onInterrupt?.();
        ctx.abort();
      },
    },
    {
      id: "ampi.quit",
      noun: "ampi",
      verb: "quit",
      description: "Quit",
      defaultKey: "ctrl+c ctrl+c",
      keywords: ["exit"],
      run: (ctx) => {
        // Pi exits once the agent is idle, so stop a running turn first.
        if (!ctx.isIdle()) ctx.abort();
        ctx.shutdown();
      },
    },
    {
      id: "thread.scrollToTop",
      noun: "thread",
      verb: "scroll to top",
      description: "Jump to the start of the transcript",
      defaultKey: "home",
      availability: (ctx) => scrollAvailability(host, ctx),
      run: () => getMmrTranscriptScroller(host.getTui())?.toTop(),
    },
    {
      id: "thread.scrollToBottom",
      noun: "thread",
      verb: "scroll to bottom",
      description: "Jump to the end of the transcript and follow new output",
      defaultKey: "end",
      availability: (ctx) => scrollAvailability(host, ctx),
      run: () => getMmrTranscriptScroller(host.getTui())?.toBottom(),
    },
    {
      id: "prompt.openInEditor",
      noun: "prompt",
      verb: "open in editor",
      description: "Edit the prompt in your external editor",
      defaultKey: "ctrl+g",
      availability: () =>
        hasMmrEditorAction(host.getTui(), EXTERNAL_EDITOR_ACTION)
          ? AVAILABLE
          : { state: "unavailable", reason: "the prompt is not focused" },
      run: () => {
        runMmrEditorAction(host.getTui(), EXTERNAL_EDITOR_ACTION);
      },
    },
    {
      id: "ampi.showVersion",
      noun: "ampi",
      verb: "show version",
      description: "Show the ampi and Pi versions",
      run: (ctx) => ctx.ui.notify(`ampi ${readAmpiVersion() ?? "(unknown version)"} on Pi ${PI_VERSION}`, "info"),
    },
    {
      id: "thread.toggleDetails",
      noun: "thread",
      verb: "toggle details",
      description: "Expand or collapse tool output and thinking together",
      defaultKey: "alt+t",
      run: (ctx) => {
        const expand = !ctx.ui.getToolsExpanded();
        ctx.ui.setToolsExpanded(expand);
        // Pi keeps thinking visibility separately; bring it in line, so one
        // key shows or hides every detail of the transcript.
        if (thinkingHidden(host) === expand) runMmrEditorAction(host.getTui(), THINKING_TOGGLE_ACTION);
      },
    },
    {
      id: "prompt.toggleHelp",
      noun: "prompt",
      verb: "toggle shortcuts help",
      description: "Show or hide the shortcuts help in the prompt box",
      defaultKey: "?",
      keywords: ["shortcuts", "keys"],
      // With text in the prompt, ? is typed as usual.
      availability: (ctx) => (ctx.ui.getEditorText().length > 0 ? PROMPT_HAS_TEXT : AVAILABLE),
      run: () => host.toggleHelp?.(),
    },
    coreSlashCommand(host, CORE_SLASH.status, {
      id: "ampi.status",
      noun: "ampi",
      verb: "show status",
      description: "Show the current mode, model and tools, as /ampi-status does",
    }),
    coreSlashCommand(host, CORE_SLASH.changelog, {
      id: "ampi.changelog",
      noun: "ampi",
      verb: "show changelog",
      description: "Show what changed in recent ampi releases",
    }),
    coreSlashCommand(host, CORE_SLASH.config, {
      id: "ampi.config",
      noun: "ampi",
      verb: "configure",
      description: "Pick the models for modes and subagents, or set up ampi-web",
    }),
    ...MMR_MODE_KEYS.map((mode) =>
      coreSlashCommand(
        host,
        `${CORE_SLASH.mode} ${mode}`,
        { id: `mode.use.${mode}`, noun: "mode", verb: `use ${mode}`, description: `Switch to the ${mode} mode` },
        () =>
          getMmrModeState()?.mode === mode ? { state: "unavailable", reason: `${mode} is the current mode` } : AVAILABLE,
      ),
    ),
  ];
}

/**
 * Palette rows for Pi's slash commands under the `pi` category: Pi's
 * built-in commands, then extension commands, prompt templates and skills.
 * Legacy `mmr-*` aliases and the core commands that ampi rows already run
 * are left out. A built-in command that reads no arguments is submitted
 * through the prompt, as typing it and pressing Enter would. Every other
 * command may take arguments, so its row puts `/<name> ` into the prompt
 * for you to finish and send. Both need an empty prompt.
 */
export function createMmrSlashPaletteCommands(host: MmrTuiCommandHost): MmrCommandDefinition[] {
  const commands = new Map<string, { description: string; submit: boolean }>(
    MMR_PI_BUILTIN_SLASH_COMMANDS.map((command) => [
      command.name,
      { description: command.description, submit: !command.takesArguments },
    ]),
  );
  try {
    for (const command of host.pi.getCommands()) {
      if (!commands.has(command.name) && !command.name.startsWith("mmr-") && !CORE_SLASH_NAMES.has(command.name)) {
        commands.set(command.name, { description: command.description ?? "Pi command", submit: false });
      }
    }
  } catch {}
  return [...commands].map(([name, { description, submit }]) => ({
    id: `pi.${name}`,
    noun: "pi",
    verb: `/${name}`,
    description,
    availability: (ctx: ExtensionContext): MmrCommandAvailability => {
      if (ctx.ui.getEditorText().length > 0) return PROMPT_HAS_TEXT;
      if (submit && !canMmrSubmitEditorText(host.getTui())) {
        return { state: "unavailable", reason: "the prompt is not focused" };
      }
      return AVAILABLE;
    },
    run: (ctx: ExtensionContext) => {
      if (!submit) {
        ctx.ui.setEditorText(`/${name} `);
        // Pi's setEditorText does not redraw; without this the text shows only after the next key.
        host.getTui()?.requestRender();
      } else if (!submitMmrEditorText(host.getTui(), `/${name}`)) throw new Error("the prompt is not focused");
    },
  }));
}

/** Register the `ampi-tui` commands. Returns a function that unregisters them. */
export function registerMmrTuiCommands(host: MmrTuiCommandHost): () => void {
  const commands = createMmrTuiCommands(host);
  for (const command of commands) registerMmrCommand(command);
  return () => {
    for (const command of commands) unregisterMmrCommand(command.id);
  };
}
