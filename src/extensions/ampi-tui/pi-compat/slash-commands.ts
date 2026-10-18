/**
 * Names of Pi's built-in slash commands (`/model`, `/tree` and so on). Pi
 * handles them in its interactive editor and keeps the list internal;
 * `pi.getCommands()` returns only extension commands, prompt templates and
 * skills. The probe test compares this list with Pi's source.
 */
export const MMR_PI_BUILTIN_SLASH_COMMANDS: readonly string[] = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];
