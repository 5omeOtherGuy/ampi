import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveMmrPackageRoot } from "../../ampi-core/changelog.js";
import {
  type MmrCommandAvailability,
  type MmrCommandDefinition,
  registerMmrCommand,
  unregisterMmrCommand,
} from "../../ampi-core/command-registry.js";
import { hasMmrEditorAction, runMmrEditorAction } from "../pi-compat/editor.js";
import { getMmrTranscriptScroller } from "../pi-compat/scroll.js";

/** Commands `ampi-tui` registers in ampi-core's command registry. */

export interface MmrTuiCommandHost {
  /** The TUI handle, once Pi has handed one to a component factory. */
  getTui(): TUI | undefined;
}

const AVAILABLE: MmrCommandAvailability = { state: "available" };
const EXTERNAL_EDITOR_ACTION = "app.editor.external";

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

export function createMmrTuiCommands(host: MmrTuiCommandHost): MmrCommandDefinition[] {
  return [
    {
      id: "thread.interrupt",
      noun: "thread",
      verb: "interrupt",
      description: "Stop the running turn",
      defaultKey: "esc esc",
      availability: (ctx) => (ctx.isIdle() ? { state: "unavailable", reason: "nothing is running" } : AVAILABLE),
      run: (ctx) => ctx.abort(),
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
  ];
}

/** Register the `ampi-tui` commands. Returns a function that unregisters them. */
export function registerMmrTuiCommands(host: MmrTuiCommandHost): () => void {
  const commands = createMmrTuiCommands(host);
  for (const command of commands) registerMmrCommand(command);
  return () => {
    for (const command of commands) unregisterMmrCommand(command.id);
  };
}
