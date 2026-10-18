/**
 * Pi's built-in slash commands (`/model`, `/tree` and so on) with Pi's own
 * descriptions. Pi handles them in its interactive editor and keeps the list
 * internal; `pi.getCommands()` returns only extension commands, prompt
 * templates and skills. `takesArguments` marks the commands whose handler
 * reads text after the name (`/name <name>`, `/compact <instructions>`). The
 * probe test compares names and descriptions with Pi's list, and the
 * argument flags with Pi's submit handler.
 */
export interface MmrPiBuiltinSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly takesArguments?: true;
}

export const MMR_PI_BUILTIN_SLASH_COMMANDS: readonly MmrPiBuiltinSlashCommand[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)", takesArguments: true },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "thinking", description: "Set thinking level", takesArguments: true },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", takesArguments: true },
  { name: "import", description: "Import and resume a session from a JSONL file", takesArguments: true },
  { name: "share", description: "Share session via a Radius artifact or a GitHub gist" },
  { name: "bug", description: "Report a bug to the Pi developers", takesArguments: true },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name", takesArguments: true },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication", takesArguments: true },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context", takesArguments: true },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pi" },
];
